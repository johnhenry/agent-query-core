// React bindings — thin useSyncExternalStore helpers over the core's versioned
// stores (cache entries, broker queue, devtools hub). Adapters build their
// protocol-specific hooks (useTask, useSession, …) on these.

import { useCallback, useSyncExternalStore } from "react";
import type { QueryCache, CacheEntry } from "../cache.js";
import type { InteractionBroker, Interaction, AuditEntry, BaseDecision } from "../broker.js";
import type { StatusStore, PeerStatus } from "../status.js";

const zero = () => 0;

/**
 * Subscribe to any versioned store: re-render when `getVersion()` changes.
 * The server snapshot defaults to 0 so SSR output is deterministic regardless of
 * live store state (pass `getServerVersion` to override).
 */
export function useVersioned(
  subscribe: (fn: () => void) => () => void,
  getVersion: () => number,
  getServerVersion: () => number = zero,
): number {
  return useSyncExternalStore(subscribe, getVersion, getServerVersion);
}

/**
 * Observe one cache entry reactively. The subscription is keyed by the cache's own
 * canonical serializer, so structurally-equal keys built inline on every render
 * (or with different property orders across call sites) never cause resubscribe churn.
 */
export function useCacheEntry<K>(cache: QueryCache<K>, key: K): CacheEntry<unknown, K> | undefined {
  const stableKey = cache.serializeKey(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stableKey is the canonical identity of `key`
  const subscribe = useCallback((fn: () => void) => cache.subscribe(key, fn), [cache, stableKey]);
  useSyncExternalStore(
    subscribe,
    () => cache.getVersion(key),
    zero, // SSR: no live store on the server — a constant keeps hydration deterministic
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

/** One peer's connectivity status, reactively. */
export function usePeerStatus(store: StatusStore, peer: string): PeerStatus | undefined;
/** ALL peers' statuses (the store's `list()`), reactively. */
export function usePeerStatus(store: StatusStore): Array<[string, PeerStatus]>;
export function usePeerStatus(
  store: StatusStore,
  peer?: string,
): PeerStatus | undefined | Array<[string, PeerStatus]> {
  const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
  useSyncExternalStore(
    subscribe,
    () => store.getVersion(),
    zero, // SSR: no live store on the server — a constant keeps hydration deterministic
  );
  return peer === undefined ? store.list() : store.get(peer);
}

export { AgentQueryDevtools } from "./devtools.js";
export type { AgentQueryDevtoolsProps } from "./devtools.js";
