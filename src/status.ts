// StatusStore — per-peer connectivity as a versioned reactive store.
//
// The state vocabulary is gRPC's channel connectivity model (IDLE / CONNECTING /
// READY / TRANSIENT_FAILURE / SHUTDOWN), renamed for this layer: gRPC's
// TRANSIENT_FAILURE is our "degraded" (the peer is unhealthy but the connection
// layer keeps retrying), SHUTDOWN is our "closed" (terminal — no further
// transitions). Like a gRPC channel, a peer's status is a small state machine
// the UI can watch; unlike the QueryCache, there are no staleness or gc
// semantics here — a peer's status is always "current truth", never cached data.

export type ConnectivityState = "idle" | "connecting" | "ready" | "degraded" | "closed";

export interface PeerStatus {
  state: ConnectivityState;
  /** When the peer ENTERED this state (stamped on state change only, not on merges). */
  since: number;
  /** Consecutive connection attempts; reset to 0 on transition to "ready". */
  attempt: number;
  /** The most recent connection-layer error, if any. */
  lastError?: Error;
  /** When the connection layer will retry next (for "retrying in Ns" UIs). */
  retryAt?: number;
}

export interface StatusStoreOptions {
  /** Injectable clock (same pattern as QueryCache) — used for `since` stamps. */
  now?: () => number;
}

/**
 * Versioned store of per-peer connectivity, in the broker's reactive style:
 * a monotonic version counter bumped on every `set`, observed by hooks via
 * `subscribe`/`getVersion` (useSyncExternalStore-compatible).
 */
export class StatusStore {
  private peers = new Map<string, PeerStatus>();
  private listeners = new Set<() => void>();
  private version = 0;
  private now: () => number;

  constructor(opts: StatusStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Monotonic counter bumped on every `set`/`remove` — what useVersioned observes. */
  getVersion(): number {
    return this.version;
  }

  get(peer: string): PeerStatus | undefined {
    return this.peers.get(peer);
  }

  list(): Array<[string, PeerStatus]> {
    return [...this.peers.entries()];
  }

  /**
   * Merge a partial status for a peer (state is required). Semantics:
   * - `since` is stamped ONLY when `state` actually changes — repeated sets in
   *   the same state (e.g. bumping `attempt` while "connecting") preserve it.
   * - `attempt` resets to 0 on any transition INTO "ready" (a successful
   *   connection wipes the retry count), overriding a caller-supplied value.
   * - Other fields merge over the previous status; pass `undefined` explicitly
   *   to clear `lastError`/`retryAt`.
   */
  set(peer: string, partial: Partial<PeerStatus> & { state: ConnectivityState }): void {
    const prev = this.peers.get(peer);
    const changed = prev?.state !== partial.state;
    const next: PeerStatus = {
      state: partial.state,
      since: changed || !prev ? this.now() : prev.since,
      attempt:
        changed && partial.state === "ready" ? 0 : (partial.attempt ?? prev?.attempt ?? 0),
      lastError: "lastError" in partial ? partial.lastError : prev?.lastError,
      retryAt: "retryAt" in partial ? partial.retryAt : prev?.retryAt,
    };
    this.peers.set(peer, next);
    this.bump();
  }

  remove(peer: string): void {
    if (this.peers.delete(peer)) this.bump();
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
