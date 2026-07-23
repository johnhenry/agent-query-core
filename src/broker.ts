// InteractionBroker — one place that mediates every protocol event needing a human:
// approvals, permission prompts, input requests, consent flows. They share a shape —
// pending request → surface to UI → await an approve/deny decision → resolve — so
// they share this machinery instead of each adapter re-rolling UI plumbing.
//
// Interaction TYPES are adapter-defined strings (MCP: "sampling"/"elicitation";
// A2A: "input-required"/"auth-required"; ACP: "permission"; AP2: "mandate"). The
// decision shape is generic so adapters can carry protocol-specific fields
// (edited payloads, selected options, structured content) through the queue.

export type InteractionPhase = "request" | "response";

/** Trust policy verdict per request. */
export type PolicyVerdict = "allow" | "deny" | "ask";

export interface PolicyContext {
  peer: string;
  type: string;
  payload: unknown;
}

export interface Interaction {
  id: number;
  type: string;
  phase: InteractionPhase;
  /** The remote party this interaction concerns (server / agent / merchant …). */
  peer: string;
  payload: unknown;
  /** True when the human must AUTHOR the result, not just approve it. */
  manual?: boolean;
  createdAt: number;
}

export interface BaseDecision {
  action: "approve" | "deny";
  reason?: string;
}

export interface AuditEntry {
  id: number;
  at: number;
  peer: string;
  type: string;
  outcome: "auto-allow" | "auto-deny" | "approved" | "denied" | "error";
  reason?: string;
}

export interface InteractionBrokerOptions {
  /** Per-request trust policy. Default: "ask" for everything. */
  policy?: (ctx: PolicyContext) => PolicyVerdict | Promise<PolicyVerdict>;
  /** Audit sink (also kept in an in-memory ring buffer). */
  onAudit?: (entry: AuditEntry) => void;
  now?: () => number;
  /** Ring-buffer capacity for the in-memory audit trail. Default 500. */
  auditCapacity?: number;
}

export class InteractionBroker<D extends BaseDecision = BaseDecision> {
  private pending = new Map<number, { interaction: Interaction; resolve: (d: D) => void }>();
  private audit: AuditEntry[] = [];
  private listeners = new Set<() => void>();
  private auditSinks = new Set<(e: AuditEntry) => void>();
  private seq = 0;
  private version = 0;
  private now: () => number;
  private capacity: number;

  constructor(private opts: InteractionBrokerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.capacity = opts.auditCapacity ?? 500;
    if (opts.onAudit) this.auditSinks.add(opts.onAudit);
  }

  // ── reactive store (for hooks/devtools) ─────────────────────────────────
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
  list = (): Interaction[] => [...this.pending.values()].map((p) => p.interaction);
  auditLog = (): readonly AuditEntry[] => this.audit;
  addAuditSink = (fn: (e: AuditEntry) => void): (() => void) => {
    this.auditSinks.add(fn);
    return () => this.auditSinks.delete(fn);
  };

  /** UI settles a pending interaction. */
  resolve = (id: number, decision: D): void => {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(decision);
    this.bump();
  };

  /** Run the trust policy for an interaction without queuing it. */
  async decide(ctx: PolicyContext): Promise<PolicyVerdict> {
    return this.opts.policy ? await this.opts.policy(ctx) : "ask";
  }

  /**
   * The full gate: policy first, then (on "ask") queue for a human. Returns the
   * decision — auto verdicts synthesize one. Adapters usually call this from
   * their protocol handlers and map the decision back onto the wire.
   *
   * ⚠️ DECISION CONTRACT — when `D` extends `BaseDecision` with **required** extra
   * fields, you MUST pass `autoApprove` / `autoDeny`. The built-in fallbacks are the
   * bare `{ action: "approve" }` / `{ action: "deny" }` objects cast to `D` — the
   * type system cannot verify them against your extension, so an auto verdict
   * without an explicit decision would hand your protocol handler an object missing
   * those required fields at runtime. (Optional extra fields are safe to omit.)
   *
   * `timeoutMs` (optional, default: wait forever) bounds the human wait on the
   * "ask" path only: if the UI never resolves, the pending interaction is removed
   * from the queue, the audit trail records outcome `"error"` with reason
   * `"timeout"`, and the gate returns verdict `"denied"` with the `autoDeny`
   * decision (or `{ action: "deny", reason: "timeout" }`). Auto verdicts are
   * unaffected.
   */
  async gate(
    type: string,
    peer: string,
    payload: unknown,
    opts: { phase?: InteractionPhase; manual?: boolean; autoApprove?: D; autoDeny?: D; timeoutMs?: number } = {},
  ): Promise<{ verdict: "auto-allow" | "auto-deny" | "approved" | "denied"; decision: D }> {
    const verdict = await this.decide({ peer, type, payload });
    if (verdict === "deny") {
      this.record(peer, type, "auto-deny");
      return { verdict: "auto-deny", decision: opts.autoDeny ?? ({ action: "deny" } as D) };
    }
    if (verdict === "allow") {
      this.record(peer, type, "auto-allow");
      return { verdict: "auto-allow", decision: opts.autoApprove ?? ({ action: "approve" } as D) };
    }
    const queued = this.enqueueTracked(type, opts.phase ?? "request", peer, payload, opts.manual ?? false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced =
      opts.timeoutMs == null
        ? await queued.promise
        : await Promise.race([
            queued.promise,
            // NOTE: deliberately NOT unref'd — the caller is awaiting this deadline, so
            // in Node it must keep the process alive until it fires or the UI answers.
            new Promise<"__timeout__">((res) => {
              timer = setTimeout(() => res("__timeout__"), opts.timeoutMs);
            }),
          ]);
    if (timer) clearTimeout(timer);
    if (raced === "__timeout__") {
      // Withdraw the now-moot interaction from the UI queue.
      if (this.pending.delete(queued.id)) this.bump();
      this.record(peer, type, "error", "timeout");
      return { verdict: "denied", decision: opts.autoDeny ?? ({ action: "deny", reason: "timeout" } as D) };
    }
    const decision = raced;
    const outcome = decision.action === "approve" ? "approved" : "denied";
    this.record(peer, type, outcome, decision.reason);
    return { verdict: outcome, decision };
  }

  /** Queue an interaction and await the UI's decision (no policy consultation). */
  enqueue(type: string, phase: InteractionPhase, peer: string, payload: unknown, manual = false): Promise<D> {
    return this.enqueueTracked(type, phase, peer, payload, manual).promise;
  }

  private enqueueTracked(
    type: string,
    phase: InteractionPhase,
    peer: string,
    payload: unknown,
    manual: boolean,
  ): { id: number; promise: Promise<D> } {
    const id = ++this.seq;
    const interaction: Interaction = { id, type, phase, peer, payload, manual, createdAt: this.now() };
    const promise = new Promise<D>((resolve) => {
      this.pending.set(id, { interaction, resolve });
      this.bump();
    });
    return { id, promise };
  }

  /** Append to the audit trail (adapters may record protocol-side outcomes too). */
  record(peer: string, type: string, outcome: AuditEntry["outcome"], reason?: string): void {
    const entry: AuditEntry = { id: ++this.seq, at: this.now(), peer, type, outcome, reason };
    this.audit.push(entry);
    if (this.audit.length > this.capacity) this.audit.shift();
    for (const sink of this.auditSinks) sink(entry);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
