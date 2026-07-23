# API reference — every export, with an example

A complete catalog of the public surface. Conceptual background lives in
[design.md](./design.md); runnable demos are in [`examples/`](../examples).

- [`QueryCache<K>`](#querycachek)
- [`structuralEqual`](#structuralequal)
- [`entityTag`](#entitytag)
- [`InteractionBroker<D>`](#interactionbrokerd)
- [`runInterceptors`](#runinterceptors)
- [`instrumentTransport`](#instrumenttransport)
- [`DevtoolsHub<TEvent>`](#devtoolshubtevent)
- [`MemoryCacheStore` / `CacheStore`](#memorycachestore--cachestore)
- [`persistCache`](#persistcache)
- [`StatusStore`](#statusstore)
- [`withRetry`](#withretry)
- [Refetch triggers](#refetch-triggers)
- [React bindings (`/react`)](#react-bindings-react)

---

## `QueryCache<K>`

The reactive L1. Generic over the adapter's structured key type; the adapter supplies
the canonical serializer.

```ts
import { QueryCache } from "@johnhenry/agent-query-core";

type Key = { kind: "doc"; id: string };
const cache = new QueryCache<Key>({
  serializeKey: (k) => JSON.stringify([k.kind, k.id]),
  // now?: () => number            — injectable clock (tests)
  // events?: CacheEvents<K>       — onSubscribe/onUnsubscribe/onInvalidate/onInvalidateTags
  // defaultStaleTime?: number     — default 30_000
  // defaultGcTime?: number        — default 300_000
});
```

### Reads

```ts
cache.serializeKey({ kind: "doc", id: "a" }); // '["doc","a"]' — the canonical string form
cache.getSnapshot(key);                       // CacheEntry | undefined
cache.getVersion(key);                        // number — what useSyncExternalStore observes
cache.isStale(key);                           // true if missing, non-success, or past staleTime
cache.entriesForDevtools();                   // CacheEntry[] — every live entry
```

### Writes

```ts
cache.write(key, data, { tags: ["doc:a"], staleTime: 60_000, gcTime: 600_000, scope: "private" });
cache.setFetching(key);                 // refetch marker; keeps "success" when data is cached
cache.setError(key, new Error("boom")); // status "error"; prior data kept (stale-but-renderable)
```

Writes apply structural sharing: deep-equal data keeps the old reference and does not
bump the version (no re-render), but still refreshes `updatedAt`.

### Subscriptions

```ts
const unsubscribe = cache.subscribe(key, () => console.log("changed"));
const unAll = cache.subscribeAll(() => {}); // any entry changed (the persister uses this)
```

`subscribe` ref-counts observers per entry: the first arrival fires
`events.onSubscribe` (adapters start protocol subscriptions here), the last departure
fires `events.onUnsubscribe` and arms the gc timer. Unsubscribe fns are idempotent.

### Invalidation

```ts
cache.invalidateTags(["task:agentA:42"]);        // mark carriers stale + broadcast
cache.invalidateTags(["task:agentA:42"], false); // protocol-driven: stale locally, no re-broadcast
cache.invalidateKeys([keyA, keyB]);              // by structured key: stale + emit + onInvalidate,
                                                 // no tag index, no distributed broadcast
```

### Optimistic updates

```ts
const rollback = cache.patch([{ key, recipe: (prev) => ({ ...(prev as object), done: true }) }]);
try {
  await mutate();
} catch {
  rollback(); // restores prior data; removes entries that only existed for the patch
}
```

Every patched entry carries `isOptimistic: true` (Firestore's `hasPendingWrites`
idea) until the next server-confirmed `write()` or a rollback clears it — a
*boolean*, not a counter, so overlapping patches share the flag. A confirming write
whose data equals the optimistic value still emits (the flag transition is
observable). Optimistic state never persists: `hydrate` always lands entries with
`isOptimistic: false`.

```tsx
const entry = useCacheEntry(cache, key);
return <span style={{ opacity: entry?.isOptimistic ? 0.5 : 1 }}>{render(entry?.data)}</span>;
```

### Eviction

```ts
cache.remove(key);                          // one entry: abort in-flight, drop tags, notify
cache.clear();                              // everything
cache.clear((k) => k.kind === "doc");       // by structured-key predicate (e.g. per tenant)
```

### In-flight de-duplication

```ts
const existing = cache.inflight(key);       // Promise | undefined — join instead of refetching
cache.setInflight(key, promise, abortController);
cache.abortInflight(key);                   // aborts only if the entry is unobserved
```

### Persistence hooks

```ts
const snapshot = cache.dehydrate();  // successful entries: data + tags + updatedAt (age)
cache.hydrate(snapshot);             // restores WITH original age — staleness math still applies
```

### Protocol subscription flag

```ts
cache.setProtocolSubscribed(key, true); // never gc an entry backing a live protocol subscription
```

## `structuralEqual`

The deep equality used for structural sharing — exported for adapters that need the
same notion (e.g. suppressing no-change poll updates before they reach the cache).

```ts
import { structuralEqual } from "@johnhenry/agent-query-core";
structuralEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }); // true
```

## `entityTag`

Opt-in convention for an app-declared normalization layer.

```ts
import { entityTag } from "@johnhenry/agent-query-core";
cache.write(issueKey, issue, { tags: [entityTag("Issue", issue.id)] });
cache.invalidateTags([entityTag("Issue", 1234)]); // every query that declared this entity
```

## `InteractionBroker<D>`

Policy → queue → audit for every human-in-the-loop decision point. `D` extends
`BaseDecision` (`{ action: "approve" | "deny"; reason?: string }`) with
protocol-specific fields.

```ts
import { InteractionBroker, type BaseDecision } from "@johnhenry/agent-query-core";

interface PermissionDecision extends BaseDecision {
  optionId?: string;
}

const broker = new InteractionBroker<PermissionDecision>({
  policy: ({ peer, type, payload }) => (peer === "trusted" ? "allow" : "ask"),
  onAudit: (entry) => log.write(entry), // durable sink; ring buffer kept regardless
  auditCapacity: 500,
});
```

### `gate(type, peer, payload, opts?)` — the composition adapters call

```ts
const { verdict, decision } = await broker.gate("permission", "agentA", params, {
  // ⚠️ REQUIRED when D has required extra fields — the built-in auto fallbacks are
  // bare {action} objects cast to D and cannot be type-checked against your extension:
  autoApprove: { action: "approve", optionId: "allow-once" },
  autoDeny: { action: "deny", optionId: "reject-once" },
  timeoutMs: 60_000, // optional; default = wait forever. On expiry: interaction
  // withdrawn, audit outcome "error"/"timeout", verdict "denied" with autoDeny.
  // phase?: "request" | "response";  manual?: boolean (human must AUTHOR the result)
});
// verdict: "auto-allow" | "auto-deny" | "approved" | "denied"
```

### Queue + reactive store (what a UI binds to)

```ts
broker.list();                       // pending Interaction[]
broker.resolve(id, { action: "approve", optionId: "allow-once" }); // UI settles one
broker.subscribe(fn);                // change notifications; returns unsubscribe
broker.getVersion();                 // monotonic version for useSyncExternalStore
```

### Lower-level pieces

```ts
await broker.decide({ peer, type, payload });   // run the policy only (no queue)
await broker.enqueue("consent", "request", "peerA", payload); // queue only (no policy)
broker.record("peerA", "call", "approved", "why");            // append to the audit trail
broker.auditLog();                                            // readonly AuditEntry[]
const un = broker.addAuditSink((e) => {});                    // extra sink; returns remover
```

## `runInterceptors`

Koa-style onion around a logical operation.

```ts
import { runInterceptors, type RequestInterceptor } from "@johnhenry/agent-query-core";

const auth: RequestInterceptor = async (op, next) => {
  if (!op.context?.meta?.principal) throw new Error("unauthenticated");
  return next(op);
};
const timing: RequestInterceptor = async (op, next) => {
  const t0 = performance.now();
  try {
    return await next(op);
  } finally {
    console.log(op.kind, op.target, performance.now() - t0);
  }
};

const result = await runInterceptors(
  [auth, timing],
  { kind: "call", peer: "srv", target: "tools/echo", args: { x: 1 }, state: {} },
  async (op) => realExecute(op), // innermost: the actual operation
);
```

Interceptors may mutate `op` (context, args), replace it entirely when calling `next`,
short-circuit by returning without `next`, or throw. `op.state` is a scratch bag for
threading data down the chain.

## `instrumentTransport`

Structural Proxy tap over any transport-shaped object (`{ send, onmessage? }`) —
both directions land in the traffic callback; the consumer's `onmessage` assignment
still works through the proxy.

```ts
import { instrumentTransport } from "@johnhenry/agent-query-core";

const tapped = instrumentTransport(transport, (e) => {
  console.log(e.dir, e.message.method ?? e.message.id); // "in" | "out"
});
client.connect(tapped); // use the tapped transport wherever the original went
```

## `DevtoolsHub<TEvent>`

Ring-buffer event hub with fan-out — the store a devtools panel reads.

```ts
import { DevtoolsHub } from "@johnhenry/agent-query-core";

const hub = new DevtoolsHub<{ type: string; detail?: unknown }>(1000); // capacity, default 500
hub.emit({ type: "cache:write", detail: { key } });
hub.events();          // readonly TEvent[] — oldest dropped past capacity
hub.subscribe(fn);     // notified per emit; returns unsubscribe
hub.getVersion();      // monotonic, bumped per emit — pairs with useVersioned in panels
```

## `MemoryCacheStore` / `CacheStore`

The async L2 tier interface behind the synchronous L1 — cross-instance sharing and
distributed tag invalidation. `MemoryCacheStore` is the in-process reference
implementation (tests; several clients in one process).

```ts
import { MemoryCacheStore, type CacheStore } from "@johnhenry/agent-query-core";

const store: CacheStore = new MemoryCacheStore();
await store.set('["doc","a"]', { data, tags: ["doc:a"], updatedAt: Date.now(), scope: "public" });
await store.get('["doc","a"]');
await store.publishInvalidation?.(["doc:a"]);          // broadcast to other nodes
const un = store.subscribeInvalidations?.((tags) => cache.invalidateTags(tags, false));
```

Note the `scope: "private"` rule on `StoredEntry`: adapters never write private
entries to a shared store unless the key carries a partition (the partition *is* the
authorization context).

## `persistCache`

Offline/restore over any synchronous storage. Hydrates on start, debounce-saves on
change (default 250ms), best-effort — storage errors never crash the app, and the
debounce timer never holds a Node process open.

```ts
import { persistCache } from "@johnhenry/agent-query-core";

const stop = persistCache(cache, localStorage, { key: "my-app-cache", debounce: 500 });
// … later (teardown): cancels any pending save and detaches
stop();
```

## `StatusStore`

Per-peer connectivity as a versioned reactive store — the gRPC channel-state model
(`idle | connecting | ready | degraded | closed`), no cache semantics. `since` is
stamped on state *change* only; `attempt` resets to 0 on any transition into
`"ready"`; other fields merge (pass `undefined` explicitly to clear).

```ts
import { StatusStore } from "@johnhenry/agent-query-core";

const status = new StatusStore(/* { now?: () => number } */);
status.set("mcp:files", { state: "connecting", attempt: 1 });
status.set("mcp:files", { state: "degraded", attempt: 2, lastError: err, retryAt: Date.now() + 400 });
status.set("mcp:files", { state: "ready" });     // attempt → 0
status.get("mcp:files");                          // PeerStatus | undefined
status.list();                                    // Array<[peer, PeerStatus]>
const un = status.subscribe(() => render());      // bumped version per set/remove
status.getVersion();
status.remove("mcp:files");
```

## `withRetry`

Exponential backoff with full jitter and an *explicit idempotency contract*
(Stripe's idempotency-key lesson): unless the caller passes `idempotent: true`,
the first failure rethrows immediately — no retries. Make the call idempotent
first (canonically: reuse the same message/request id on every attempt so the
peer dedupes), then assert it. Backoff timers are unref'd; an `AbortSignal`
rejects promptly mid-delay with the abort reason.

```ts
import { withRetry } from "@johnhenry/agent-query-core";

const result = await withRetry(
  (attempt) => sendMessage({ id: "msg-42", body }),   // same id every attempt
  {
    retries: 3,           // after the initial attempt
    baseDelayMs: 200,     // default 200
    maxDelayMs: 30_000,   // default 30_000
    factor: 2,            // default 2
    jitter: true,         // default: full jitter — delay = random() * min(max, base*factor^n)
    retryOn: (err) => isTransient(err),  // false ⇒ rethrow; default always-true
    // random?: () => number             — injectable for deterministic tests
  },
  {
    idempotent: true,     // REQUIRED assertion — false/omitted ⇒ no retries, ever
    signal: ac.signal,
    onRetry: (err, attempt, delayMs) => log(`attempt ${attempt} failed; backing off ${delayMs}ms`),
  },
);
```

## Refetch triggers

TanStack's lesson: staleness needs *occasions*. A `Trigger` subscribes a `fire`
callback to an occasion source and returns an unsubscriber; `wireRevalidation`
turns each fire into "mark matching entries stale + fire `events.onInvalidate`"
via `cache.invalidateKeys`.

```ts
import { focusTrigger, onlineTrigger, intervalTrigger, wireRevalidation } from "@johnhenry/agent-query-core";

// Built-ins: window refocus / visibility, back-online, unref'd polling interval.
const stopFocus = wireRevalidation(cache, focusTrigger);
const stopOnline = wireRevalidation(cache, onlineTrigger);
const stopPoll = wireRevalidation(cache, intervalTrigger(30_000));

// Default filter: entries with subscribers > 0 (only data someone is watching).
// A predicate REPLACES that filter entirely (it can include unobserved entries):
const stopTasks = wireRevalidation(cache, intervalTrigger(5_000), {
  predicate: (e) => (e.cacheKey as A2AKey).kind === "task",
});

stopFocus(); // each returns the trigger's unsubscriber
```

`focusTrigger`/`onlineTrigger` are no-ops (with no-op unsubscribers) outside a DOM.
A custom trigger is just a function: `const t: Trigger = (fire) => bus.on("wake", fire);`.

## React bindings (`/react`)

Thin `useSyncExternalStore` helpers; adapters build protocol hooks (`useTask`,
`useSession`, …) on these. React is an optional peer dependency — the root entrypoint
never imports it.

```tsx
import { useCacheEntry, useInteractions, useAuditLog, useVersioned } from "@johnhenry/agent-query-core/react";

function Doc({ id }: { id: string }) {
  // Inline keys are fine: the subscription is keyed by the cache's canonical
  // serializer, so a fresh object each render never churns subscriptions.
  const entry = useCacheEntry(cache, { kind: "doc", id });
  if (!entry || entry.status !== "success") return <Spinner />;
  return <pre>{JSON.stringify(entry.data)}</pre>;
}

function ApprovalQueue() {
  const { interactions, resolve } = useInteractions(broker); // broker may be undefined
  return interactions.map((i) => (
    <Prompt key={i.id} interaction={i} onApprove={() => resolve(i.id, { action: "approve" })} />
  ));
}

function AuditPanel() {
  const log = useAuditLog(broker); // readonly AuditEntry[], re-renders as entries land
  return <ol>{log.map((e) => <li key={e.id}>{e.outcome}</li>)}</ol>;
}

// Bind anything with subscribe/getVersion (e.g. a DevtoolsHub adapter):
const version = useVersioned(subscribe, getVersion /*, getServerVersion = () => 0 */);
```

### `usePeerStatus`

```tsx
import { usePeerStatus } from "@johnhenry/agent-query-core/react";

function PeerBadge({ peer }: { peer: string }) {
  const s = usePeerStatus(statusStore, peer); // PeerStatus | undefined
  return <span className={s?.state ?? "unknown"}>{peer}: {s?.state ?? "—"}</span>;
}

function PeerList() {
  const all = usePeerStatus(statusStore); // peer omitted → Array<[name, PeerStatus]>
  return <ul>{all.map(([name, s]) => <li key={name}>{name} · {s.state}</li>)}</ul>;
}
```

### `<AgentQueryDevtools>`

Zero-dependency, inline-styled floating panel (dark, monospace, fixed bottom-right,
collapsible): event timeline with a type filter, cache entry table (key, status,
stale, optimistic, subscribers, age), pending interactions, and peer-status chips.
Every store except the hub is optional.

```tsx
import { AgentQueryDevtools } from "@johnhenry/agent-query-core/react";

<AgentQueryDevtools hub={hub} cache={cache} broker={broker} status={statusStore}
                    title="mcpq" defaultOpen />
```

SSR note: server snapshots are the constant `0`, so server-rendered output is
deterministic and hydration never mismatches; live values arrive on first client
subscription.
