// React bindings — thin useSyncExternalStore helpers over the core's versioned
// stores (cache entries, broker queue, devtools hub). Adapters build their
// protocol-specific hooks (useTask, useSession, …) on these.

import { useCallback, useSyncExternalStore } from "react";
import type { QueryCache, CacheEntry } from "../cache.js";
import type { InteractionBroker, Interaction, AuditEntry, BaseDecision } from "../broker.js";

/** Subscribe to any versioned store: re-render when `getVersion()` changes. */
export function useVersioned(subscribe: (fn: () => void) => () => void, getVersion: () => number): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Observe one cache entry reactively. */
export function useCacheEntry<K>(cache: QueryCache<K>, key: K): CacheEntry<unknown, K> | undefined {
  const subscribe = useCallback((fn: () => void) => cache.subscribe(key, fn), [cache, JSON.stringify(key)]);
  useSyncExternalStore(
    subscribe,
    () => cache.getVersion(key),
    () => cache.getVersion(key),
  );
  return cache.getSnapshot(key);
}

/** The broker's pending queue + resolver, reactively. */
export function useInteractions<D extends BaseDecision>(
  broker: InteractionBroker<D> | undefined,
): { interactions: Interaction[]; resolve: (id: number, decision: D) => void } {
  const subscribe = useCallback((fn: () => void) => (broker ? broker.subscribe(fn) : () => {}), [broker]);
  useSyncExternalStore(
    subscribe,
    () => broker?.getVersion() ?? 0,
    () => 0,
  );
  return {
    interactions: broker?.list() ?? [],
    resolve: (id, decision) => broker?.resolve(id, decision),
  };
}

/** The broker's audit trail, reactively. */
export function useAuditLog(broker: InteractionBroker<BaseDecision> | undefined): readonly AuditEntry[] {
  const subscribe = useCallback((fn: () => void) => (broker ? broker.subscribe(fn) : () => {}), [broker]);
  useSyncExternalStore(
    subscribe,
    () => broker?.getVersion() ?? 0,
    () => 0,
  );
  return broker?.auditLog() ?? [];
}
