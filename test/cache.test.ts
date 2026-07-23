import { describe, it, expect, vi } from "vitest";
import { QueryCache, structuralEqual } from "../src/cache.js";

type Key = { kind: string; peer: string; id: string; partition?: string };
const make = (opts: Partial<ConstructorParameters<typeof QueryCache<Key>>[0]> = {}) =>
  new QueryCache<Key>({ serializeKey: (k) => JSON.stringify([k.kind, k.peer, k.id, k.partition ?? ""]), ...opts });
const K = (id: string, partition?: string): Key => ({ kind: "doc", peer: "p1", id, partition });

describe("QueryCache basics", () => {
  it("writes, reads, and reports freshness by staleTime", () => {
    let now = 1000;
    const cache = make({ now: () => now });
    cache.write(K("a"), { v: 1 }, { staleTime: 50 });
    expect(cache.getSnapshot(K("a"))?.data).toEqual({ v: 1 });
    expect(cache.isStale(K("a"))).toBe(false);
    now += 60;
    expect(cache.isStale(K("a"))).toBe(true);
  });

  it("structural sharing: an equal rewrite keeps the reference and does not bump the version", () => {
    const cache = make();
    cache.write(K("a"), { list: [1, 2, 3] });
    const before = cache.getSnapshot(K("a"))!;
    const ref = before.data;
    const v = before.version;
    cache.write(K("a"), { list: [1, 2, 3] });
    const after = cache.getSnapshot(K("a"))!;
    expect(after.data).toBe(ref);
    expect(after.version).toBe(v);
    cache.write(K("a"), { list: [1, 2, 4] });
    expect(cache.getSnapshot(K("a"))!.version).toBeGreaterThan(v);
  });

  it("tag invalidation marks matching entries stale and fires events (broadcast gated)", () => {
    const onInvalidate = vi.fn();
    const onInvalidateTags = vi.fn();
    const cache = make({ events: { onInvalidate, onInvalidateTags } });
    cache.write(K("a"), 1, { tags: ["t:x"] });
    cache.write(K("b"), 2, { tags: ["t:y"] });
    cache.invalidateTags(["t:x"]);
    expect(cache.getSnapshot(K("a"))?.isStale).toBe(true);
    expect(cache.getSnapshot(K("b"))?.isStale).toBe(false);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidateTags).toHaveBeenCalledWith(["t:x"]);
    cache.invalidateTags(["t:y"], false); // protocol-driven: no re-broadcast
    expect(onInvalidateTags).toHaveBeenCalledTimes(1);
  });

  it("ref-counts subscribers and fires onSubscribe/onUnsubscribe at the edges", () => {
    const onSubscribe = vi.fn();
    const onUnsubscribe = vi.fn();
    const cache = make({ events: { onSubscribe, onUnsubscribe } });
    const un1 = cache.subscribe(K("a"), () => {});
    const un2 = cache.subscribe(K("a"), () => {});
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    un1();
    expect(onUnsubscribe).not.toHaveBeenCalled();
    un2();
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("gc evicts unobserved entries after gcTime (protocolSubscribed entries survive)", async () => {
    vi.useFakeTimers();
    try {
      const cache = make();
      cache.write(K("gone"), 1, { gcTime: 20 });
      cache.write(K("kept"), 2, { gcTime: 20 });
      cache.setProtocolSubscribed(K("kept"), true);
      await vi.advanceTimersByTimeAsync(30);
      expect(cache.getSnapshot(K("gone"))).toBeUndefined();
      expect(cache.getSnapshot(K("kept"))?.data).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("patch applies optimistic updates and rolls back", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    const rollback = cache.patch([{ key: K("a"), recipe: (prev) => ({ n: (prev as { n: number }).n + 1 }) }]);
    expect(cache.getSnapshot(K("a"))?.data).toEqual({ n: 2 });
    rollback();
    expect(cache.getSnapshot(K("a"))?.data).toEqual({ n: 1 });
  });

  it("dehydrate/hydrate round-trips data, tags, and AGE", () => {
    let now = 1000;
    const a = make({ now: () => now });
    a.write(K("a"), "x", { tags: ["t:x"] });
    const snap = a.dehydrate();
    now = 5000;
    const b = make({ now: () => now });
    b.hydrate(JSON.parse(JSON.stringify(snap)));
    const e = b.getSnapshot(K("a"))!;
    expect(e.data).toBe("x");
    expect(e.updatedAt).toBe(1000); // age preserved → staleness math still applies
    expect([...e.tags]).toEqual(["t:x"]);
  });

  it("clear(predicate) evicts selectively (e.g. by partition)", () => {
    const cache = make();
    cache.write(K("a", "t1"), 1);
    cache.write(K("b", "t2"), 2);
    cache.clear((k) => k.partition === "t1");
    expect(cache.getSnapshot(K("a", "t1"))).toBeUndefined();
    expect(cache.getSnapshot(K("b", "t2"))?.data).toBe(2);
  });

  it("inflight de-dupes and abortInflight only fires when unobserved", () => {
    const cache = make();
    const ac = new AbortController();
    const p = new Promise(() => {});
    cache.setInflight(K("a"), p, ac);
    expect(cache.inflight(K("a"))).toBe(p);
    const un = cache.subscribe(K("a"), () => {});
    cache.abortInflight(K("a"));
    expect(ac.signal.aborted).toBe(false); // observed → not aborted
    un();
    cache.abortInflight(K("a"));
    expect(ac.signal.aborted).toBe(true);
  });

  it("stores the scope hint on write", () => {
    const cache = make();
    cache.write(K("a"), 1, { scope: "private" });
    expect(cache.getSnapshot(K("a"))?.scope).toBe("private");
  });
});

describe("structuralEqual", () => {
  it("deep-compares objects/arrays and rejects shape mismatches", () => {
    expect(structuralEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(structuralEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structuralEqual([1, 2], [2, 1])).toBe(false);
    expect(structuralEqual(null, {})).toBe(false);
  });
});

describe("QueryCache edge cases", () => {
  it("serializeKey exposes the adapter's canonical serializer", () => {
    const cache = make();
    expect(cache.serializeKey(K("a"))).toBe(JSON.stringify(["doc", "p1", "a", ""]));
    // property order must not matter (same serializer output)
    expect(cache.serializeKey({ id: "a", peer: "p1", kind: "doc" })).toBe(cache.serializeKey(K("a")));
  });

  it("patch on a never-written key creates a provisional entry; rollback removes it entirely", () => {
    const cache = make();
    const rollback = cache.patch([{ key: K("ghost"), recipe: () => ({ optimistic: true }) }]);
    const e = cache.getSnapshot(K("ghost"))!;
    expect(e.data).toEqual({ optimistic: true });
    expect(e.status).toBe("idle"); // data-only patch: never claims "success"
    rollback();
    expect(cache.getSnapshot(K("ghost"))).toBeUndefined(); // no ghost left behind
  });

  it("rollback on a real entry restores prior data (and keeps the entry)", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    const rollback = cache.patch([{ key: K("a"), recipe: () => ({ n: 99 }) }]);
    rollback();
    expect(cache.getSnapshot(K("a"))?.data).toEqual({ n: 1 });
    expect(cache.getSnapshot(K("a"))?.status).toBe("success");
  });

  it("rollback skips ghost removal if a real write landed in between", () => {
    const cache = make();
    const rollback = cache.patch([{ key: K("g"), recipe: () => "optimistic" }]);
    cache.write(K("g"), "server-truth");
    rollback();
    expect(cache.getSnapshot(K("g"))?.data).toBe("server-truth"); // status became success → not removed…
    expect(cache.getSnapshot(K("g"))?.status).toBe("success");
  });

  it("provisional patched entries gc when unobserved (no permanent leak)", async () => {
    vi.useFakeTimers();
    try {
      const cache = make({ defaultGcTime: 20 });
      cache.patch([{ key: K("ghost"), recipe: () => 1 }]); // rollback never called
      await vi.advanceTimersByTimeAsync(30);
      expect(cache.getSnapshot(K("ghost"))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrate notifies subscribers with the PRESERVED age already in place", () => {
    let now = 9000;
    const cache = make({ now: () => now });
    const seen: number[] = [];
    cache.subscribe(K("a"), () => seen.push(cache.getSnapshot(K("a"))!.updatedAt));
    cache.hydrate({ entries: [{ cacheKey: K("a"), data: "x", tags: [], updatedAt: 1000 }] });
    expect(seen).toEqual([1000]); // not 9000-then-rewound
  });

  it("hydrate applies structural sharing (identical data: same ref, no version bump)", () => {
    const cache = make();
    cache.write(K("a"), { deep: [1, 2] });
    const before = cache.getSnapshot(K("a"))!;
    const ref = before.data;
    const v = before.version;
    cache.hydrate({ entries: [{ cacheKey: K("a"), data: { deep: [1, 2] }, tags: [], updatedAt: 500 }] });
    const after = cache.getSnapshot(K("a"))!;
    expect(after.data).toBe(ref);
    expect(after.version).toBe(v);
    expect(after.updatedAt).toBe(500); // age still preserved
  });

  it("hydrated-but-unobserved entries get a gc deadline", async () => {
    vi.useFakeTimers();
    try {
      const cache = make({ defaultGcTime: 20 });
      cache.hydrate({ entries: [{ cacheKey: K("a"), data: 1, tags: [], updatedAt: 0 }] });
      await vi.advanceTimersByTimeAsync(30);
      expect(cache.getSnapshot(K("a"))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrate clears a prior error state", () => {
    const cache = make();
    cache.setError(K("a"), new Error("boom"));
    cache.hydrate({ entries: [{ cacheKey: K("a"), data: "ok", tags: [], updatedAt: 1 }] });
    const e = cache.getSnapshot(K("a"))!;
    expect(e.status).toBe("success");
    expect(e.error).toBeUndefined();
  });

  it("setFetching: errored entries show 'fetching' again (error kept), success stays 'success'", () => {
    const cache = make();
    cache.setError(K("a"), new Error("boom"));
    cache.setFetching(K("a"));
    const a = cache.getSnapshot(K("a"))!;
    expect(a.status).toBe("fetching");
    expect(a.error?.message).toBe("boom"); // last failure still visible during retry
    cache.write(K("b"), 1);
    cache.setFetching(K("b"));
    expect(cache.getSnapshot(K("b"))?.status).toBe("success"); // stale-while-revalidate
  });

  it("setError sets status and keeps prior data (stale-but-renderable)", () => {
    const cache = make();
    cache.write(K("a"), "good");
    cache.setError(K("a"), new Error("later failure"));
    const e = cache.getSnapshot(K("a"))!;
    expect(e.status).toBe("error");
    expect(e.data).toBe("good");
    expect(cache.isStale(K("a"))).toBe(true); // non-success is always stale
  });

  it("invalidateTags on an unknown tag is a silent no-op (no onInvalidate)", () => {
    const onInvalidate = vi.fn();
    const onInvalidateTags = vi.fn();
    const cache = make({ events: { onInvalidate, onInvalidateTags } });
    cache.write(K("a"), 1, { tags: ["t:x"] });
    cache.invalidateTags(["t:nope"]);
    expect(onInvalidate).not.toHaveBeenCalled(); // fires only when entries were touched
    expect(onInvalidateTags).toHaveBeenCalledWith(["t:nope"]); // broadcast still happens
    expect(cache.getSnapshot(K("a"))?.isStale).toBe(false);
  });

  it("re-tagging a write drops the old tag index (invalidate by old tag misses)", () => {
    const cache = make();
    cache.write(K("a"), 1, { tags: ["old"] });
    cache.write(K("a"), 2, { tags: ["new"] });
    cache.invalidateTags(["old"]);
    expect(cache.getSnapshot(K("a"))?.isStale).toBe(false);
    cache.invalidateTags(["new"]);
    expect(cache.getSnapshot(K("a"))?.isStale).toBe(true);
  });

  it("subscribe → remove → write recreates the entry WITH the live subscriber count", async () => {
    vi.useFakeTimers();
    try {
      const cache = make({ defaultGcTime: 20 });
      const notified = vi.fn();
      const un = cache.subscribe(K("a"), notified);
      cache.write(K("a"), 1);
      cache.remove(K("a"));
      expect(notified).toHaveBeenCalled(); // eviction notifies observers
      cache.write(K("a"), 2); // recreated while still observed
      expect(cache.getSnapshot(K("a"))?.subscribers).toBe(1);
      await vi.advanceTimersByTimeAsync(30);
      expect(cache.getSnapshot(K("a"))?.data).toBe(2); // NOT gc'd under a live observer
      un();
      await vi.advanceTimersByTimeAsync(30);
      expect(cache.getSnapshot(K("a"))).toBeUndefined(); // …and gc resumes after unsubscribe
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribe is idempotent (double call does not corrupt the ref count)", () => {
    const onUnsubscribe = vi.fn();
    const cache = make({ events: { onUnsubscribe } });
    const un1 = cache.subscribe(K("a"), () => {});
    const un2 = cache.subscribe(K("a"), () => {});
    un1();
    un1(); // double-unsubscribe
    expect(onUnsubscribe).not.toHaveBeenCalled(); // un2 still holds the entry
    expect(cache.getSnapshot(K("a"))?.subscribers).toBe(1);
    un2();
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("two subscribers on one key both hear every emit; unsubscribing during emit is safe", () => {
    const cache = make();
    const heardA: number[] = [];
    const heardB: number[] = [];
    let unA: () => void = () => {};
    unA = cache.subscribe(K("a"), () => {
      heardA.push(1);
      unA(); // self-unsubscribe mid-emit
    });
    cache.subscribe(K("a"), () => heardB.push(1));
    cache.write(K("a"), 1);
    cache.write(K("a"), 2);
    expect(heardA).toHaveLength(1); // gone after first emit
    expect(heardB).toHaveLength(2);
  });

  it("subscribing re-arms a pending gc (clears the timer)", async () => {
    vi.useFakeTimers();
    try {
      const cache = make();
      cache.write(K("a"), 1, { gcTime: 20 }); // unobserved → gc armed
      cache.subscribe(K("a"), () => {}); // observer arrives before the deadline
      await vi.advanceTimersByTimeAsync(50);
      expect(cache.getSnapshot(K("a"))?.data).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear() without a predicate evicts everything", () => {
    const cache = make();
    cache.write(K("a"), 1);
    cache.write(K("b"), 2);
    cache.clear();
    expect(cache.entriesForDevtools()).toHaveLength(0);
  });

  it("remove aborts the in-flight fetch and clears tag index entries", () => {
    const onInvalidate = vi.fn();
    const cache = make({ events: { onInvalidate } });
    const ac = new AbortController();
    cache.write(K("a"), 1, { tags: ["t:x"] });
    cache.setInflight(K("a"), new Promise(() => {}), ac);
    cache.remove(K("a"));
    expect(ac.signal.aborted).toBe(true);
    cache.invalidateTags(["t:x"]);
    expect(onInvalidate).not.toHaveBeenCalled(); // tag index no longer points at the ghost
  });

  it("remove of an unknown key is a no-op", () => {
    const cache = make();
    expect(() => cache.remove(K("nope"))).not.toThrow();
  });

  it("subscribeAll fires on any entry change and stops after unsubscribe", () => {
    const cache = make();
    const all = vi.fn();
    const un = cache.subscribeAll(all);
    cache.write(K("a"), 1);
    cache.write(K("b"), 2);
    expect(all).toHaveBeenCalledTimes(2);
    un();
    cache.write(K("c"), 3);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("getVersion returns 0 for unknown keys and bumps per emit", () => {
    const cache = make();
    expect(cache.getVersion(K("a"))).toBe(0);
    cache.write(K("a"), 1);
    const v1 = cache.getVersion(K("a"));
    cache.write(K("a"), 2);
    expect(cache.getVersion(K("a"))).toBeGreaterThan(v1);
  });

  it("dehydrate only includes successful entries", () => {
    const cache = make();
    cache.write(K("ok"), 1);
    cache.setError(K("bad"), new Error("x"));
    cache.setFetching(K("loading"));
    const snap = cache.dehydrate();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.data).toBe(1);
  });
});

describe("entityTag", () => {
  it("formats type:id", async () => {
    const { entityTag } = await import("../src/cache.js");
    expect(entityTag("Issue", 1234)).toBe("Issue:1234");
    expect(entityTag("User", "ada")).toBe("User:ada");
  });
});

describe("isOptimistic (hasPendingWrites-style flag)", () => {
  it("initializes false, set by patch, cleared by a server-confirmed write", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(false);
    cache.patch([{ key: K("a"), recipe: () => ({ n: 2 }) }]);
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(true);
    cache.write(K("a"), { n: 2 }); // server confirms
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(false);
  });

  it("a write with data equal to the optimistic value STILL emits (flag transition)", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    cache.patch([{ key: K("a"), recipe: () => ({ n: 2 }) }]);
    const listener = vi.fn();
    cache.subscribe(K("a"), listener);
    const v = cache.getVersion(K("a"));
    cache.write(K("a"), { n: 2 }); // deep-equal to optimistic data, but flag flips
    expect(cache.getVersion(K("a"))).toBe(v + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(false);
    // ...and a genuinely unchanged non-optimistic rewrite stays silent.
    cache.write(K("a"), { n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rollback clears the flag and restores data", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    const rollback = cache.patch([{ key: K("a"), recipe: () => ({ n: 99 }) }]);
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(true);
    rollback();
    expect(cache.getSnapshot(K("a"))!.data).toEqual({ n: 1 });
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(false);
  });

  it("overlapping patches share the flag; rolling back the inner one keeps it set", () => {
    const cache = make();
    cache.write(K("a"), { n: 1 });
    cache.patch([{ key: K("a"), recipe: () => ({ n: 2 }) }]); // outer, stays pending
    const rollbackInner = cache.patch([{ key: K("a"), recipe: () => ({ n: 3 }) }]);
    rollbackInner();
    expect(cache.getSnapshot(K("a"))!.data).toEqual({ n: 2 });
    expect(cache.getSnapshot(K("a"))!.isOptimistic).toBe(true); // outer patch still unconfirmed
  });

  it("ghost-entry rollback removes the entry wholesale (flag dies with it)", () => {
    const cache = make();
    const rollback = cache.patch([{ key: K("ghost"), recipe: () => "temp" }]);
    expect(cache.getSnapshot(K("ghost"))!.isOptimistic).toBe(true);
    rollback();
    expect(cache.getSnapshot(K("ghost"))).toBeUndefined();
  });

  it("ghost rollback after a superseding write keeps the (non-optimistic) server truth", () => {
    const cache = make();
    const rollback = cache.patch([{ key: K("ghost"), recipe: () => "temp" }]);
    cache.write(K("ghost"), "server");
    expect(cache.getSnapshot(K("ghost"))!.isOptimistic).toBe(false);
    rollback();
    expect(cache.getSnapshot(K("ghost"))!.data).toBe("server");
    expect(cache.getSnapshot(K("ghost"))!.isOptimistic).toBe(false);
  });

  it("hydrate never restores optimistic state (and emits when clearing it)", () => {
    const source = make();
    source.write(K("a"), { n: 1 });
    const snapshot = source.dehydrate();

    const target = make();
    target.write(K("a"), { n: 0 });
    target.patch([{ key: K("a"), recipe: () => ({ n: 1 }) }]); // optimistic, equal to snapshot data
    expect(target.getSnapshot(K("a"))!.isOptimistic).toBe(true);
    const listener = vi.fn();
    target.subscribe(K("a"), listener);
    target.hydrate(snapshot);
    expect(target.getSnapshot(K("a"))!.isOptimistic).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1); // flag transition emitted despite equal data
  });
});
