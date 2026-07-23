// Refetch triggers — TanStack Query's lesson that staleness needs OCCASIONS:
// data doesn't refetch because it's stale, it refetches because something
// happened (window refocus, network back online, a timer) while it was stale.
// A Trigger is just "call `fire` when the occasion occurs, return a teardown";
// wireRevalidation turns a fire into "mark the observed entries stale + notify",
// and the adapter's refetch machinery (wired to `events.onInvalidate`) does the rest.

import type { QueryCache, CacheEntry } from "./cache.js";

/** An occasion source: subscribe `fire` to it, return an unsubscriber. */
export type Trigger = (fire: () => void) => () => void;

/**
 * Fires when the document becomes visible again (`visibilitychange` → visible)
 * or the window regains focus. Outside a DOM (`typeof document === "undefined"`,
 * e.g. Node) it is a no-op and returns a no-op unsubscriber.
 */
export const focusTrigger: Trigger = (fire) => {
  if (typeof document === "undefined") return () => {};
  const onVisibility = () => {
    if (document.visibilityState === "visible") fire();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", fire);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", fire);
  };
};

/** Fires when the browser comes back online (window `online`). No-op outside a DOM. */
export const onlineTrigger: Trigger = (fire) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", fire);
  return () => window.removeEventListener("online", fire);
};

/** Fires every `ms` milliseconds. The timer is unref'd — it never holds a Node process open. */
export function intervalTrigger(ms: number): Trigger {
  return (fire) => {
    const timer = setInterval(fire, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  };
}

export interface WireRevalidationOpts<K> {
  /**
   * Which entries a fire marks stale. Default: entries with `subscribers > 0`
   * (only data someone is looking at). A supplied predicate REPLACES the default
   * filter entirely — it is not ANDed with the subscriber check — so a predicate
   * can deliberately include unobserved entries.
   */
  predicate?: (entry: CacheEntry<unknown, K>) => boolean;
}

/**
 * Wire a trigger to a cache: on each fire, mark the matching entries stale and
 * fire the cache's `events.onInvalidate` with their keys (via `invalidateKeys`).
 * Returns the trigger's unsubscriber — call it to stop revalidating.
 */
export function wireRevalidation<K>(
  cache: QueryCache<K>,
  trigger: Trigger,
  opts: WireRevalidationOpts<K> = {},
): () => void {
  const predicate = opts.predicate ?? ((e: CacheEntry<unknown, K>) => e.subscribers > 0);
  return trigger(() => {
    const keys = cache
      .entriesForDevtools()
      .filter(predicate)
      .map((e) => e.cacheKey);
    if (keys.length) cache.invalidateKeys(keys);
  });
}
