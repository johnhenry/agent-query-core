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
