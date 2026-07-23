// @johnhenry/agent-query-core — the protocol-agnostic engine behind the *-query
// family of agent-protocol data layers (mcpq, a2aq, acpq, …). Adapters supply the
// protocol vocabulary (key kinds, tag conventions, interaction types, transports);
// this package supplies the reactive machinery.

export { QueryCache, structuralEqual, entityTag } from "./cache.js";
export type { CacheEntry, CacheEvents, CachePatch, CacheWriteOpts, QueryCacheOptions, Tag } from "./cache.js";
export { InteractionBroker } from "./broker.js";
export type {
  AuditEntry,
  BaseDecision,
  Interaction,
  InteractionBrokerOptions,
  InteractionPhase,
  PolicyContext,
  PolicyVerdict,
} from "./broker.js";
export { runInterceptors } from "./interceptors.js";
export type { Next, Operation, OperationContext, RequestInterceptor } from "./interceptors.js";
export { MemoryCacheStore } from "./cacheStore.js";
export type { CacheStore, StoredEntry } from "./cacheStore.js";
export { persistCache } from "./persist.js";
export type { PersistOptions, SyncStorage } from "./persist.js";
export { instrumentTransport } from "./instrument.js";
export type { TrafficDirection, TrafficEvent, TransportLike } from "./instrument.js";
export { DevtoolsHub } from "./devtools.js";
export type { DevtoolsEventBase, DevtoolsSink } from "./devtools.js";
export { StatusStore } from "./status.js";
export type { ConnectivityState, PeerStatus, StatusStoreOptions } from "./status.js";
export { withRetry } from "./retry.js";
export type { RetryPolicy, WithRetryOpts } from "./retry.js";
export { focusTrigger, onlineTrigger, intervalTrigger, wireRevalidation } from "./triggers.js";
export type { Trigger, WireRevalidationOpts } from "./triggers.js";
