// QueryCache — the reactive centerpiece of every *-query data layer:
//   - staleTime / gcTime            (TanStack Query)
//   - tag-based invalidation        (RTK Query providesTags / invalidatesTags)
//   - protocol-driven invalidation  (adapters wire push signals to invalidateTags)
//   - ref-counted subscribers       (drives gc AND protocol-level subscriptions)
//
// Framework-agnostic; React bindings sit on top via useSyncExternalStore.
// Generic over the adapter's structured key type K — the adapter supplies the
// serializer (protocol key vocabularies stay out of the core).

export type Tag = string;

/** Opt-in entity tag for an app-declared normalization layer, e.g. entityTag("Issue", 1234). */
export const entityTag = (type: string, id: string | number): Tag => `${type}:${id}`;

export interface CacheEntry<T = unknown, K = unknown> {
  key: string;
  /** The structured key — so consumers never have to parse `key`. */
  cacheKey: K;
  data?: T;
  error?: Error;
  status: "idle" | "fetching" | "success" | "error";
  isStale: boolean;
  updatedAt: number;
  staleTime: number;
  gcTime: number;
  tags: Set<Tag>;
  subscribers: number;
  /** Monotonic counter bumped on every emit — the value useSyncExternalStore observes. */
  version: number;
  /** Whether the connection layer holds a live protocol subscription for this entry. */
  protocolSubscribed: boolean;
  /** Sharing scope hint from the protocol (e.g. MCP SEP-2549 cacheScope); undefined = unhinted. */
  scope?: "public" | "private";
  /** In-flight request, for de-duping concurrent reads of the same key. */
  inflight?: Promise<unknown>;
  /** Aborts the in-flight fetch when the last observer unsubscribes. */
  abort?: AbortController;
  gcTimer?: ReturnType<typeof setTimeout>;
}

export interface CacheWriteOpts {
  tags?: Tag[];
  staleTime?: number;
  gcTime?: number;
  /** Sharing-scope hint; "private" entries should not cross authorization contexts. */
  scope?: "public" | "private";
}

export interface CachePatch<K = unknown> {
  key: K;
  /** Produce the next data from the previous (optimistic update). */
  recipe: (prev: unknown) => unknown;
}

type Listener = () => void;

export interface CacheEvents<K = unknown> {
  onSubscribe?: (entry: CacheEntry<unknown, K>) => void; // first subscriber arrived
  onUnsubscribe?: (entry: CacheEntry<unknown, K>) => void; // last subscriber left
  onInvalidate?: (keys: string[]) => void; // for devtools + auto-refetch wiring
  onInvalidateTags?: (tags: Tag[]) => void; // for distributed (L2) invalidation broadcast
}

const DEFAULT_STALE = 30_000; // freshly fetched data is fresh for 30s by default
const DEFAULT_GC = 5 * 60_000;

export interface QueryCacheOptions<K> {
  /** Canonical string form of a structured key (stable across equal keys). */
  serializeKey: (key: K) => string;
  now?: () => number;
  events?: CacheEvents<K>;
  defaultStaleTime?: number;
  defaultGcTime?: number;
}

export class QueryCache<K = unknown> {
  private entries = new Map<string, CacheEntry<unknown, K>>();
  private tagIndex = new Map<Tag, Set<string>>(); // tag -> entry keys
  private listeners = new Map<string, Set<Listener>>(); // entry key -> hook listeners
  private globalListeners = new Set<() => void>();
  private now: () => number;
  private events: CacheEvents<K>;
  private serialize: (key: K) => string;
  private defaultStale: number;
  private defaultGc: number;

  constructor(opts: QueryCacheOptions<K>) {
    this.serialize = opts.serializeKey;
    this.now = opts.now ?? (() => Date.now());
    this.events = opts.events ?? {};
    this.defaultStale = opts.defaultStaleTime ?? DEFAULT_STALE;
    this.defaultGc = opts.defaultGcTime ?? DEFAULT_GC;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  /** Canonical string form of a structured key (the adapter-supplied serializer). */
  serializeKey(key: K): string {
    return this.serialize(key);
  }

  getSnapshot(key: K): CacheEntry<unknown, K> | undefined {
    return this.entries.get(this.serialize(key));
  }

  /** The value useSyncExternalStore observes — changes on every emit for this key. */
  getVersion(key: K): number {
    return this.entries.get(this.serialize(key))?.version ?? 0;
  }

  /** True if the entry is missing, errored, or older than its staleTime. */
  isStale(key: K): boolean {
    const e = this.getSnapshot(key);
    if (!e || e.status !== "success") return true;
    return e.isStale || this.now() - e.updatedAt > e.staleTime;
  }

  // ── useSyncExternalStore plumbing ────────────────────────────────────────
  /** Returns an unsubscribe fn. Ref-counts subscribers and drives gc + protocol subscribe. */
  subscribe(key: K, fn: Listener): () => void {
    const k = this.serialize(key);
    const entry = this.ensure(key);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(fn);
    entry.subscribers++;
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }
    if (entry.subscribers === 1) this.events.onSubscribe?.(entry);

    return () => {
      // Idempotent: a second call (or a call after the listener set was replaced)
      // must not decrement the ref count again.
      const s = this.listeners.get(k);
      if (!s || !s.delete(fn)) return;
      if (s.size === 0) this.listeners.delete(k);
      // Look the entry up fresh: `remove()` may have evicted the captured entry and a
      // later write recreated it. Decrementing the orphaned object would leak the count.
      const cur = this.entries.get(k);
      if (!cur) return;
      cur.subscribers = Math.max(0, cur.subscribers - 1);
      if (cur.subscribers === 0) {
        this.events.onUnsubscribe?.(cur);
        this.scheduleGc(cur);
      }
    };
  }

  // ── eviction ─────────────────────────────────────────────────────────────
  /**
   * Evict one entry immediately (aborts any in-flight fetch, clears its gc timer, drops
   * its tag index entries). Subscribers are notified — their next snapshot is undefined.
   */
  remove(key: K): void {
    const k = this.serialize(key);
    const e = this.entries.get(k);
    if (!e) return;
    e.abort?.abort();
    if (e.gcTimer) clearTimeout(e.gcTimer);
    for (const tag of e.tags) this.tagIndex.get(tag)?.delete(e.key);
    this.entries.delete(k);
    for (const fn of this.listeners.get(k) ?? []) fn();
    for (const fn of this.globalListeners) fn();
    // Keep the listener set: live subscribers (e.g. a mounted hook) still observe the key.
    if (!this.listeners.get(k)?.size) this.listeners.delete(k);
  }

  /**
   * Evict everything, or everything whose structured key matches the predicate — e.g.
   * `clear((k) => k.agent === name)` after removing a peer, or by partition when a
   * tenant session ends.
   */
  clear(predicate?: (cacheKey: K) => boolean): void {
    for (const e of [...this.entries.values()]) {
      if (predicate && !predicate(e.cacheKey)) continue;
      this.remove(e.cacheKey);
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────
  /**
   * Mark a refetch in flight. Entries with cached data keep status "success" (the
   * stale-while-revalidate render path); idle OR errored entries become "fetching" —
   * a retry after an error intentionally shows as loading again, though `error`
   * stays set until the next write/setError so UIs can keep showing the last failure.
   */
  setFetching(key: K): void {
    const e = this.ensure(key);
    e.status = e.status === "success" ? "success" : "fetching";
    e.inflight ??= undefined;
    this.emit(e.key);
  }

  write<T>(key: K, data: T, opts: CacheWriteOpts = {}): void {
    const e = this.ensure(key);
    // Structural sharing: if the new data deep-equals the old, keep the old reference
    // and refresh staleness WITHOUT bumping the version — so observers don't re-render
    // on a no-op update (e.g. a push notification whose bytes didn't actually change).
    const unchanged = e.status === "success" && structuralEqual(e.data, data);
    if (!unchanged) e.data = data;
    e.error = undefined;
    e.status = "success";
    e.isStale = false;
    e.updatedAt = this.now();
    if (opts.staleTime != null) e.staleTime = opts.staleTime;
    if (opts.gcTime != null) e.gcTime = opts.gcTime;
    if (opts.scope != null) e.scope = opts.scope;
    this.reindexTags(e, opts.tags);
    // Unobserved entries must not linger forever: give them a gc deadline at write time.
    if (e.subscribers === 0) this.scheduleGc(e);
    if (!unchanged) this.emit(e.key);
  }

  // ── in-flight de-duplication + abort-when-unobserved ─────────────────────
  /** The promise of an in-flight fetch for this key, if any (for request de-duping). */
  inflight(key: K): Promise<unknown> | undefined {
    return this.entries.get(this.serialize(key))?.inflight;
  }
  setInflight(key: K, promise: Promise<unknown> | undefined, abort?: AbortController): void {
    const e = this.ensure(key);
    e.inflight = promise;
    e.abort = promise ? abort : undefined;
  }
  /** Abort an in-flight fetch (called when the last observer leaves). */
  abortInflight(key: K): void {
    const e = this.entries.get(this.serialize(key));
    if (e?.subscribers === 0 && e.abort) e.abort.abort();
  }

  setError(key: K, error: Error): void {
    const e = this.ensure(key);
    e.error = error;
    e.status = "error";
    this.emit(e.key);
  }

  // ── invalidation ───────────────────────────────────────────────────────
  /** RTK Query-style: mark every entry carrying any of these tags stale. */
  invalidateTags(tags: Tag[], broadcast = true): void {
    const touched: string[] = [];
    for (const tag of tags) {
      for (const k of this.tagIndex.get(tag) ?? []) {
        const e = this.entries.get(k);
        if (e) {
          e.isStale = true;
          touched.push(k);
        }
      }
    }
    for (const k of touched) this.emit(k);
    if (touched.length) this.events.onInvalidate?.(touched);
    // Declared invalidations broadcast to other nodes; protocol-driven ones stay local
    // (each node receives its own push signal). `broadcast=false` breaks remote loops.
    if (broadcast) this.events.onInvalidateTags?.(tags);
  }

  // ── optimistic updates ───────────────────────────────────────────────────
  /**
   * Apply patches, return a rollback fn. Used by mutation hooks before a call resolves.
   * Patching a key with no successful entry creates a provisional one (status stays
   * "idle" — the patch is data-only); rolling back removes such ghosts entirely rather
   * than leaving an idle entry with stale optimistic residue.
   */
  patch(patches: CachePatch<K>[]): () => void {
    const prev: Array<{ key: string; cacheKey: K; data: unknown; existed: boolean }> = [];
    for (const p of patches) {
      const e = this.ensure(p.key);
      prev.push({ key: e.key, cacheKey: e.cacheKey, data: e.data, existed: e.status === "success" });
      e.data = p.recipe(e.data);
      // Provisional entries must not linger forever if nobody observes them.
      if (e.subscribers === 0) this.scheduleGc(e);
      this.emit(e.key);
    }
    return () => {
      for (const snap of prev) {
        const e = this.entries.get(snap.key);
        if (!e) continue;
        if (!snap.existed) {
          // The entry did not hold real data when patched. If it still doesn't,
          // evict the ghost wholesale; if a real write landed since, keep it —
          // rolling back to "nothing" would clobber fresher server truth.
          if (e.status !== "success") this.remove(snap.cacheKey);
          continue;
        }
        e.data = snap.data;
        this.emit(e.key);
      }
    };
  }

  // ── internals ──────────────────────────────────────────────────────────
  /** Mark whether the connection layer holds a live protocol subscription for this key. */
  setProtocolSubscribed(key: K, value: boolean): void {
    const e = this.entries.get(this.serialize(key));
    if (e) e.protocolSubscribed = value;
  }

  entriesForDevtools(): CacheEntry<unknown, K>[] {
    return [...this.entries.values()];
  }

  /** Fires on any change to any entry — used by the persister. */
  subscribeAll(fn: () => void): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  // ── persistence (offline / SSR hydration) ─────────────────────────────────
  /** A serializable snapshot of successful entries (data + tags + age). */
  dehydrate(): { entries: Array<{ cacheKey: K; data: unknown; tags: Tag[]; updatedAt: number }> } {
    return {
      entries: [...this.entries.values()]
        .filter((e) => e.status === "success")
        .map((e) => ({ cacheKey: e.cacheKey, data: e.data, tags: [...e.tags], updatedAt: e.updatedAt })),
    };
  }
  /**
   * Restore a snapshot. Entries keep their original age, so staleTime still applies.
   * The preserved `updatedAt` is in place BEFORE subscribers are notified (a plain
   * `write()` would emit with age "now" and silently rewind it afterwards), and
   * structural sharing still applies: hydrating data deep-equal to what's cached
   * keeps the reference and skips the version bump.
   */
  hydrate(snapshot: { entries: Array<{ cacheKey: K; data: unknown; tags: Tag[]; updatedAt: number }> }): void {
    for (const s of snapshot.entries) {
      const e = this.ensure(s.cacheKey);
      const unchanged = e.status === "success" && structuralEqual(e.data, s.data);
      if (!unchanged) e.data = s.data;
      e.error = undefined;
      e.status = "success";
      e.isStale = false;
      e.updatedAt = s.updatedAt; // preserve age rather than "now"
      this.reindexTags(e, s.tags);
      if (e.subscribers === 0) this.scheduleGc(e); // hydrated-but-unobserved entries still gc
      if (!unchanged) this.emit(e.key);
    }
  }

  private ensure(key: K): CacheEntry<unknown, K> {
    const k = this.serialize(key);
    let e = this.entries.get(k);
    if (!e) {
      e = {
        key: k,
        cacheKey: key,
        status: "idle",
        isStale: true,
        updatedAt: 0,
        staleTime: this.defaultStale,
        gcTime: this.defaultGc,
        tags: new Set(),
        // Seed from the live listener set: after `remove()`, subscribers keep
        // observing the key, so a recreated entry must inherit their ref count
        // (otherwise a write would schedule gc under an active observer).
        subscribers: this.listeners.get(k)?.size ?? 0,
        version: 0,
        protocolSubscribed: false,
      };
      this.entries.set(k, e);
    }
    return e;
  }

  private reindexTags(e: CacheEntry<unknown, K>, tags?: Tag[]): void {
    if (!tags) return;
    for (const tag of e.tags) this.tagIndex.get(tag)?.delete(e.key);
    e.tags = new Set(tags);
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) this.tagIndex.set(tag, (set = new Set()));
      set.add(e.key);
    }
  }

  private scheduleGc(e: CacheEntry<unknown, K>): void {
    if (e.protocolSubscribed) return; // never gc a live subscription
    if (e.gcTimer) clearTimeout(e.gcTimer); // re-arm (fresh write extends the deadline)
    e.gcTimer = setTimeout(() => {
      // Re-check at fire time: a subscriber OR a protocol subscription acquired
      // after arming must veto the eviction.
      if (e.subscribers > 0 || e.protocolSubscribed) return;
      for (const tag of e.tags) this.tagIndex.get(tag)?.delete(e.key);
      this.entries.delete(e.key);
      this.listeners.delete(e.key);
    }, e.gcTime);
    // Don't hold the (Node) process open for cache housekeeping; no-op in browsers.
    (e.gcTimer as unknown as { unref?: () => void }).unref?.();
  }

  private emit(key: string): void {
    const e = this.entries.get(key);
    if (e) e.version++;
    for (const fn of this.listeners.get(key) ?? []) fn();
    for (const fn of this.globalListeners) fn();
  }
}

/** Deep structural equality for cache structural sharing. */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => structuralEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      structuralEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
