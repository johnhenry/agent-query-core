import { describe, it, expect, vi } from "vitest";
import { InteractionBroker, type BaseDecision } from "../src/broker.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next pending interaction, then settle it. */
async function settleNext<D extends BaseDecision>(broker: InteractionBroker<D>, decision: D) {
  for (let i = 0; i < 100; i++) {
    const [next] = broker.list();
    if (next) {
      broker.resolve(next.id, decision);
      return next;
    }
    await tick();
  }
  throw new Error("no interaction appeared");
}

describe("InteractionBroker gate", () => {
  it('"allow" auto-approves without queuing', async () => {
    const broker = new InteractionBroker({ policy: () => "allow" });
    const { verdict, decision } = await broker.gate("permission", "peer1", { q: 1 });
    expect(verdict).toBe("auto-allow");
    expect(decision.action).toBe("approve");
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)).toMatchObject({ peer: "peer1", type: "permission", outcome: "auto-allow" });
  });

  it('"deny" auto-rejects without queuing (custom autoDeny decision carried)', async () => {
    type D = BaseDecision & { code?: string };
    const broker = new InteractionBroker<D>({ policy: () => "deny" });
    const { verdict, decision } = await broker.gate("input-required", "peer1", {}, { autoDeny: { action: "deny", code: "policy" } });
    expect(verdict).toBe("auto-deny");
    expect(decision.code).toBe("policy");
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
  });

  it('"ask" (default) queues for a human and returns the UI decision', async () => {
    type D = BaseDecision & { content?: unknown };
    const broker = new InteractionBroker<D>();
    const p = broker.gate("input-required", "agentA", { prompt: "name?" });
    const pending = await settleNext<D>(broker, { action: "approve", content: { name: "Ada" } });
    expect(pending.type).toBe("input-required");
    expect(pending.peer).toBe("agentA");
    const { verdict, decision } = await p;
    expect(verdict).toBe("approved");
    expect(decision.content).toEqual({ name: "Ada" });
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
  });

  it("deny from the UI records 'denied' with the reason", async () => {
    const broker = new InteractionBroker();
    const p = broker.gate("mandate", "merchant", {});
    await settleNext(broker, { action: "deny", reason: "too expensive" });
    const { verdict } = await p;
    expect(verdict).toBe("denied");
    expect(broker.auditLog().at(-1)).toMatchObject({ outcome: "denied", reason: "too expensive" });
  });
});

describe("broker plumbing", () => {
  it("audit ring caps at capacity and fans out to sinks", () => {
    const sink = vi.fn();
    const broker = new InteractionBroker({ auditCapacity: 2 });
    broker.addAuditSink(sink);
    broker.record("p", "t", "approved");
    broker.record("p", "t", "denied");
    broker.record("p", "t", "error");
    expect(broker.auditLog()).toHaveLength(2);
    expect(broker.auditLog().map((e) => e.outcome)).toEqual(["denied", "error"]);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("subscribe/getVersion bump on queue changes; manual flag surfaces", async () => {
    const broker = new InteractionBroker();
    const versions: number[] = [];
    broker.subscribe(() => versions.push(broker.getVersion()));
    const p = broker.enqueue("consent", "request", "peer", { x: 1 }, true);
    expect(broker.list()[0]?.manual).toBe(true);
    broker.resolve(broker.list()[0]!.id, { action: "approve" });
    await p;
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it("resolving an unknown id is a no-op", () => {
    const broker = new InteractionBroker();
    expect(() => broker.resolve(999, { action: "approve" })).not.toThrow();
  });
});

describe("gate timeoutMs", () => {
  it("denies on timeout: queue cleared, audit outcome 'error' with reason 'timeout'", async () => {
    vi.useFakeTimers();
    try {
      const broker = new InteractionBroker();
      const p = broker.gate("permission", "peer1", {}, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1); // let the interaction enqueue
      expect(broker.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1100);
      const { verdict, decision } = await p;
      expect(verdict).toBe("denied");
      expect(decision).toEqual({ action: "deny", reason: "timeout" });
      expect(broker.list()).toHaveLength(0); // withdrawn from the UI queue
      expect(broker.auditLog().at(-1)).toMatchObject({ outcome: "error", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the expiry path with timedOut, and only that path", async () => {
    vi.useFakeTimers();
    try {
      // Nobody answered is not the same fact as somebody declined. Without this
      // flag an adapter supplying autoDeny gets its own decision back on both
      // paths and cannot tell them apart, so it must smuggle a sentinel through
      // autoDeny.reason.
      const broker = new InteractionBroker();
      const timedOutCall = broker.gate("permission", "peer1", {}, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1100);
      expect((await timedOutCall).timedOut).toBe(true);

      // A human declining leaves it unset.
      const declined = broker.gate("permission", "peer1", {}, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1);
      broker.resolve(broker.list()[0]!.id, { action: "deny", reason: "not now" });
      const settled = await declined;
      expect(settled.verdict).toBe("denied");
      expect(settled.timedOut).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a policy auto-deny is never marked as a timeout", async () => {
    const broker = new InteractionBroker({ policy: () => "deny" });
    const { verdict, timedOut } = await broker.gate("permission", "peer1", {});
    expect(verdict).toBe("auto-deny");
    expect(timedOut).toBeUndefined();
  });

  it("carries a custom autoDeny decision on timeout", async () => {
    vi.useFakeTimers();
    try {
      type D = BaseDecision & { code: string };
      const broker = new InteractionBroker<D>();
      const p = broker.gate("permission", "p", {}, { timeoutMs: 50, autoDeny: { action: "deny", code: "T" } });
      await vi.advanceTimersByTimeAsync(60);
      expect((await p).decision.code).toBe("T");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a UI decision before the deadline wins (timer does not fire a second outcome)", async () => {
    vi.useFakeTimers();
    try {
      const broker = new InteractionBroker();
      const p = broker.gate("permission", "p", {}, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1);
      broker.resolve(broker.list()[0]!.id, { action: "approve" });
      const { verdict } = await p;
      expect(verdict).toBe("approved");
      const auditBefore = broker.auditLog().length;
      await vi.advanceTimersByTimeAsync(2000); // deadline passes harmlessly
      expect(broker.auditLog()).toHaveLength(auditBefore);
      expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolve after timeout is a no-op (the pending slot is gone)", async () => {
    vi.useFakeTimers();
    try {
      const broker = new InteractionBroker();
      const p = broker.gate("permission", "p", {}, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(1);
      const id = broker.list()[0]!.id;
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(() => broker.resolve(id, { action: "approve" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("without timeoutMs the gate waits indefinitely (default off)", async () => {
    vi.useFakeTimers();
    try {
      const broker = new InteractionBroker();
      let settled = false;
      const p = broker.gate("permission", "p", {});
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      broker.resolve(broker.list()[0]!.id, { action: "approve" });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("broker concurrency", () => {
  it("concurrent gates resolve independently, out of order", async () => {
    const broker = new InteractionBroker();
    const p1 = broker.gate("permission", "peerA", { n: 1 });
    const p2 = broker.gate("permission", "peerB", { n: 2 });
    await tick();
    const [i1, i2] = broker.list();
    expect(broker.list()).toHaveLength(2);
    broker.resolve(i2!.id, { action: "deny", reason: "second first" }); // LIFO
    broker.resolve(i1!.id, { action: "approve" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.verdict).toBe("approved");
    expect(r2.verdict).toBe("denied");
    expect(r2.decision.reason).toBe("second first");
    expect(broker.list()).toHaveLength(0);
  });

  it("an async policy is awaited per interaction", async () => {
    const broker = new InteractionBroker({
      policy: async ({ peer }) => {
        await tick(1);
        return peer === "trusted" ? "allow" : "deny";
      },
    });
    expect((await broker.gate("t", "trusted", {})).verdict).toBe("auto-allow");
    expect((await broker.gate("t", "evil", {})).verdict).toBe("auto-deny");
  });

  it("decide() consults the policy without queueing; defaults to 'ask'", async () => {
    const noPolicy = new InteractionBroker();
    expect(await noPolicy.decide({ peer: "p", type: "t", payload: null })).toBe("ask");
    const broker = new InteractionBroker({ policy: () => "allow" });
    expect(await broker.decide({ peer: "p", type: "t", payload: null })).toBe("allow");
    expect(broker.list()).toHaveLength(0);
  });

  it("audit sink unsubscribe stops delivery; constructor onAudit keeps receiving", () => {
    const ctor = vi.fn();
    const late = vi.fn();
    const broker = new InteractionBroker({ onAudit: ctor });
    const un = broker.addAuditSink(late);
    broker.record("p", "t", "approved");
    un();
    broker.record("p", "t", "denied");
    expect(late).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledTimes(2);
  });

  it("interaction metadata: ids are unique and increasing, createdAt uses the injected clock", async () => {
    let now = 42;
    const broker = new InteractionBroker({ now: () => now });
    void broker.enqueue("a", "request", "p", {});
    now = 43;
    void broker.enqueue("b", "response", "p", {});
    const [i1, i2] = broker.list();
    expect(i2!.id).toBeGreaterThan(i1!.id);
    expect(i1!.createdAt).toBe(42);
    expect(i2!.createdAt).toBe(43);
    expect(i2!.phase).toBe("response");
  });
});
