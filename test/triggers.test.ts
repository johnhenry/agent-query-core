import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryCache } from "../src/cache.js";
import { intervalTrigger, focusTrigger, onlineTrigger, wireRevalidation, type Trigger } from "../src/triggers.js";

const makeCache = (onInvalidate?: (keys: string[]) => void) =>
  new QueryCache<string>({ serializeKey: (k) => k, events: { onInvalidate } });

/** A hand-cranked trigger for deterministic tests. */
const manualTrigger = (): { trigger: Trigger; fire: () => void; unsubscribed: () => boolean } => {
  let f: (() => void) | undefined;
  let un = false;
  return {
    trigger: (fire) => {
      f = fire;
      return () => {
        un = true;
        f = undefined;
      };
    },
    fire: () => f?.(),
    unsubscribed: () => un,
  };
};

describe("wireRevalidation", () => {
  it("marks only subscribed entries stale and fires onInvalidate with their keys", () => {
    const onInvalidate = vi.fn();
    const cache = makeCache(onInvalidate);
    cache.write("watched", 1);
    cache.write("ignored", 2);
    const un = cache.subscribe("watched", () => {});
    const { trigger, fire } = manualTrigger();
    wireRevalidation(cache, trigger);

    fire();
    expect(cache.getSnapshot("watched")!.isStale).toBe(true);
    expect(cache.getSnapshot("ignored")!.isStale).toBe(false);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(["watched"]);
    un();
  });

  it("does not fire onInvalidate at all when nothing matches", () => {
    const onInvalidate = vi.fn();
    const cache = makeCache(onInvalidate);
    cache.write("unobserved", 1);
    const { trigger, fire } = manualTrigger();
    wireRevalidation(cache, trigger);
    fire();
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it("a predicate REPLACES the default subscribers>0 filter", () => {
    const onInvalidate = vi.fn();
    const cache = makeCache(onInvalidate);
    cache.write("a:1", 1);
    cache.write("b:1", 2);
    const { trigger, fire } = manualTrigger();
    // No subscribers anywhere — the predicate still selects entries.
    wireRevalidation(cache, trigger, { predicate: (e) => e.key.startsWith("a:") });
    fire();
    expect(cache.getSnapshot("a:1")!.isStale).toBe(true);
    expect(cache.getSnapshot("b:1")!.isStale).toBe(false);
    expect(onInvalidate).toHaveBeenCalledWith(["a:1"]);
  });

  it("unsubscribing stops revalidation", () => {
    const onInvalidate = vi.fn();
    const cache = makeCache(onInvalidate);
    cache.write("k", 1);
    cache.subscribe("k", () => {});
    const { trigger, fire, unsubscribed } = manualTrigger();
    const un = wireRevalidation(cache, trigger);
    un();
    expect(unsubscribed()).toBe(true);
    fire();
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});

describe("QueryCache.invalidateKeys", () => {
  it("marks stale, bumps versions, notifies listeners, ignores unknown keys", () => {
    const onInvalidate = vi.fn();
    const cache = makeCache(onInvalidate);
    cache.write("x", 1);
    const listener = vi.fn();
    cache.subscribe("x", listener);
    const v = cache.getVersion("x");
    cache.invalidateKeys(["x", "missing"]);
    expect(cache.getSnapshot("x")!.isStale).toBe(true);
    expect(cache.getVersion("x")).toBe(v + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(["x"]);
    cache.invalidateKeys(["missing"]); // nothing touched → no event
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe("intervalTrigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires every ms until unsubscribed", () => {
    const fire = vi.fn();
    const un = intervalTrigger(1000)(fire);
    vi.advanceTimersByTime(3500);
    expect(fire).toHaveBeenCalledTimes(3);
    un();
    vi.advanceTimersByTime(5000);
    expect(fire).toHaveBeenCalledTimes(3);
  });
});

describe("focusTrigger / onlineTrigger outside a DOM", () => {
  it("are no-ops in Node (no document/window)", () => {
    const fire = vi.fn();
    expect(typeof document).toBe("undefined");
    const un1 = focusTrigger(fire);
    const un2 = onlineTrigger(fire);
    expect(fire).not.toHaveBeenCalled();
    un1();
    un2();
  });
});
