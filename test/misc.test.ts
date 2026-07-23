import { describe, it, expect, vi } from "vitest";
import { runInterceptors, type Operation, type RequestInterceptor } from "../src/interceptors.js";
import { MemoryCacheStore } from "../src/cacheStore.js";
import { persistCache, type SyncStorage } from "../src/persist.js";
import { QueryCache } from "../src/cache.js";
import { instrumentTransport, type TrafficEvent, type TransportLike } from "../src/instrument.js";
import { DevtoolsHub } from "../src/devtools.js";

const op = (over: Partial<Operation> = {}): Operation => ({ kind: "call", peer: "p", target: "t", state: {}, ...over });

describe("interceptor onion", () => {
  it("runs in order, can mutate the operation, and exec sees the mutation", async () => {
    const order: string[] = [];
    const a: RequestInterceptor = async (o, next) => {
      order.push("a-in");
      o.context = { ...(o.context ?? {}), meta: { principal: "u1" } };
      const r = await next(o);
      order.push("a-out");
      return r;
    };
    const b: RequestInterceptor = async (o, next) => {
      order.push("b-in");
      const r = await next(o);
      order.push("b-out");
      return r;
    };
    const result = await runInterceptors([a, b], op(), async (o) => {
      order.push("exec");
      return (o.context?.meta as { principal?: string })?.principal;
    });
    expect(result).toBe("u1");
    expect(order).toEqual(["a-in", "b-in", "exec", "b-out", "a-out"]);
  });

  it("short-circuits when an interceptor returns without calling next", async () => {
    const exec = vi.fn();
    const deny: RequestInterceptor = async () => "blocked";
    const result = await runInterceptors([deny], op(), exec);
    expect(result).toBe("blocked");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("MemoryCacheStore (L2)", () => {
  it("stores, retrieves, deletes, and pub/subs invalidations across stores", async () => {
    const a = new MemoryCacheStore();
    await a.set("k1", { data: 1, tags: ["t"], updatedAt: 1 });
    expect((await a.get("k1"))?.data).toBe(1);
    const seen: string[][] = [];
    const un = a.subscribeInvalidations!((tags) => seen.push(tags));
    await a.publishInvalidation!(["t"]);
    expect(seen).toEqual([["t"]]);
    un();
    await a.delete("k1");
    expect(await a.get("k1")).toBeUndefined();
  });
});

describe("persistCache", () => {
  it("hydrates on start and debounce-saves on change", async () => {
    vi.useFakeTimers();
    try {
      const serializeKey = (k: string) => k;
      const backing = new Map<string, string>();
      const storage: SyncStorage = {
        getItem: (k) => backing.get(k) ?? null,
        setItem: (k, v) => void backing.set(k, v),
      };
      const first = new QueryCache<string>({ serializeKey });
      first.write("doc", "hello");
      backing.set("agent-query-cache", JSON.stringify(first.dehydrate()));

      const second = new QueryCache<string>({ serializeKey });
      const stop = persistCache(second, storage);
      expect(second.getSnapshot("doc")?.data).toBe("hello"); // hydrated

      second.write("doc2", "world");
      await vi.advanceTimersByTimeAsync(300); // debounce flush
      const saved = JSON.parse(backing.get("agent-query-cache")!) as { entries: unknown[] };
      expect(saved.entries).toHaveLength(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instrumentTransport", () => {
  it("taps both directions and forwards the extra inbound arg", async () => {
    const events: TrafficEvent[] = [];
    const sent: unknown[] = [];
    const inner: TransportLike = { send: async (m) => void sent.push(m) };
    const tapped = instrumentTransport(inner, (e) => events.push(e));
    const got: unknown[][] = [];
    tapped.onmessage = (m, extra) => got.push([m, extra]);
    inner.onmessage?.({ method: "x" }, { authInfo: 1 });
    await tapped.send({ method: "y", id: 1 });
    expect(events.map((e) => e.dir)).toEqual(["in", "out"]);
    expect(got).toEqual([[{ method: "x" }, { authInfo: 1 }]]);
    expect(sent).toEqual([{ method: "y", id: 1 }]);
  });
});

describe("DevtoolsHub", () => {
  it("ring-buffers events and notifies subscribers", () => {
    const hub = new DevtoolsHub<{ type: string; n: number }>(2);
    const ping = vi.fn();
    hub.subscribe(ping);
    hub.emit({ type: "a", n: 1 });
    hub.emit({ type: "b", n: 2 });
    hub.emit({ type: "c", n: 3 });
    expect(hub.events().map((e) => e.type)).toEqual(["b", "c"]);
    expect(ping).toHaveBeenCalledTimes(3);
  });
});

describe("persistCache resilience", () => {
  const serializeKey = (k: string) => k;

  it("a throwing setItem never crashes the app (best-effort persistence)", async () => {
    vi.useFakeTimers();
    try {
      const storage: SyncStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      const cache = new QueryCache<string>({ serializeKey });
      const stop = persistCache(cache, storage);
      cache.write("k", "v");
      await expect(vi.advanceTimersByTimeAsync(300)).resolves.not.toThrow();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing getItem is swallowed at startup", () => {
    const storage: SyncStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    const cache = new QueryCache<string>({ serializeKey });
    expect(() => persistCache(cache, storage)).not.toThrow();
  });

  it("a corrupt snapshot is ignored", () => {
    const storage: SyncStorage = { getItem: () => "{not json", setItem: () => {} };
    const cache = new QueryCache<string>({ serializeKey });
    expect(() => persistCache(cache, storage)).not.toThrow();
    expect(cache.entriesForDevtools()).toHaveLength(0);
  });

  it("stop() cancels a pending debounce AND detaches from future writes", async () => {
    vi.useFakeTimers();
    try {
      const setItem = vi.fn();
      const storage: SyncStorage = { getItem: () => null, setItem };
      const cache = new QueryCache<string>({ serializeKey });
      const stop = persistCache(cache, storage);
      cache.write("k", "v"); // debounce armed…
      stop(); // …but stopped before flush
      await vi.advanceTimersByTimeAsync(500);
      expect(setItem).not.toHaveBeenCalled();
      cache.write("k2", "v2"); // post-stop writes never re-arm
      await vi.advanceTimersByTimeAsync(500);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rapid writes collapse into one debounced save", async () => {
    vi.useFakeTimers();
    try {
      const setItem = vi.fn();
      const storage: SyncStorage = { getItem: () => null, setItem };
      const cache = new QueryCache<string>({ serializeKey });
      const stop = persistCache(cache, storage, { debounce: 100, key: "custom" });
      cache.write("a", 1);
      cache.write("b", 2);
      cache.write("c", 3);
      await vi.advanceTimersByTimeAsync(150);
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(setItem).toHaveBeenCalledWith("custom", expect.stringContaining('"b"'));
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instrumentTransport proxy semantics", () => {
  it("onclose/onerror assigned through the proxy land on the target and fire", () => {
    const inner: TransportLike & { onclose?: () => void; fire(): void } = {
      send: async () => {},
      fire() {
        (this.onclose as (() => void) | undefined)?.();
      },
    };
    const tapped = instrumentTransport(inner, () => {});
    const closed = vi.fn();
    (tapped as typeof inner).onclose = closed;
    inner.fire(); // the transport invokes its own handler internally
    expect(closed).toHaveBeenCalledTimes(1);
    expect(typeof (tapped as typeof inner).onclose).toBe("function"); // readable back through the proxy
  });

  it("methods read through the proxy are bound to the target (this-safe)", async () => {
    const inner = {
      count: 0,
      send: async () => {},
      bumpSelf() {
        (this as { count: number }).count++;
      },
    } satisfies TransportLike & { count: number; bumpSelf(): void };
    const tapped = instrumentTransport(inner, () => {});
    const detached = tapped.bumpSelf as () => void;
    detached(); // would throw / miss `this` if unbound
    expect(inner.count).toBe(1);
  });

  it("reading onmessage before any assignment yields undefined (the tap is invisible)", () => {
    const inner: TransportLike = { send: async () => {} };
    const tapped = instrumentTransport(inner, () => {});
    expect(tapped.onmessage).toBeUndefined();
    expect(typeof inner.onmessage).toBe("function"); // …but the wire tap is installed underneath
  });

  it("swapping onmessage re-routes; old handler stops receiving", () => {
    const inner: TransportLike = { send: async () => {} };
    const tapped = instrumentTransport(inner, () => {});
    const first = vi.fn();
    const second = vi.fn();
    tapped.onmessage = first;
    inner.onmessage?.({ method: "a" });
    tapped.onmessage = second;
    inner.onmessage?.({ method: "b" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("send tap still applies after a consumer replaces send on the proxy", async () => {
    const sent: unknown[] = [];
    const events: TrafficEvent[] = [];
    const inner: TransportLike = { send: async (m) => void sent.push(["v1", m]) };
    const tapped = instrumentTransport(inner, (e) => events.push(e));
    tapped.send2 = async () => {}; // arbitrary prop write passes through
    (tapped as { send: (m: unknown) => Promise<void> }).send = async (m: unknown) => void sent.push(["v2", m]);
    await tapped.send({ method: "x" });
    expect(events).toHaveLength(1); // still tapped
    expect(sent).toEqual([["v2", { method: "x" }]]); // replacement took effect
  });
});

describe("DevtoolsHub", () => {
  it("subscriber unsubscribe stops notifications; events() is the live ring", () => {
    const hub = new DevtoolsHub(3);
    const ping = vi.fn();
    const un = hub.subscribe(ping);
    hub.emit({ type: "a" });
    un();
    hub.emit({ type: "b" });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(hub.events().map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("default capacity is 500 (ring wraps at the cap)", () => {
    const hub = new DevtoolsHub();
    for (let i = 0; i < 505; i++) hub.emit({ type: "e", i });
    expect(hub.events()).toHaveLength(500);
    expect((hub.events()[0] as unknown as { i: number }).i).toBe(5);
  });
});

describe("interceptors errors", () => {
  it("a throwing exec propagates through the chain; interceptors can observe via try/finally", async () => {
    const seen: string[] = [];
    const timing: RequestInterceptor = async (o, next) => {
      seen.push("start");
      try {
        return await next(o);
      } finally {
        seen.push("end");
      }
    };
    await expect(
      runInterceptors([timing], op(), async () => {
        throw new Error("downstream boom");
      }),
    ).rejects.toThrow("downstream boom");
    expect(seen).toEqual(["start", "end"]);
  });

  it("an empty chain just runs exec", async () => {
    const result = await runInterceptors([], op({ target: "x" }), async (o) => o.target);
    expect(result).toBe("x");
  });

  it("interceptors can replace the operation object passed to next", async () => {
    const swap: RequestInterceptor = async (o, next) => next({ ...o, target: "swapped" });
    const result = await runInterceptors([swap], op({ target: "orig" }), async (o) => o.target);
    expect(result).toBe("swapped");
  });
});
