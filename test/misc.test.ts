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
