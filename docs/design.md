# The engine's concepts — why agent-query-core looks the way it does

[mcp-query](https://github.com/johnhenry/mcp-query) proved a shape: a declarative,
cached, reactive data layer between a UI and an agent protocol, sitting on the
protocol's official low-level SDK — the TanStack-Query-of-X move. Building
[a2a-query](https://github.com/johnhenry/a2a-query) revealed which parts of that shape
are protocol-independent. This package is those parts, extracted: no wire code, no
protocol vocabulary, no opinions about what a "resource" or a "task" is. An **adapter**
(mcpq, a2aq, acpq, …) supplies the vocabulary; the core supplies the machinery.

The contract between the two is deliberately narrow:

| Core supplies | Adapter supplies |
|---|---|
| `QueryCache<K>` — reactive entry store | structured key type `K` + `serializeKey` |
| tag invalidation machinery | tag conventions (`taskTag(agent, id)`, …) |
| `InteractionBroker<D>` — policy/queue/audit | interaction type strings + decision shape `D` |
| interceptor onion (`runInterceptors`) | which operations run through it |
| transport tap, devtools hub, persistence, L2 interface | the transports, the panels, the stores |
| React `useSyncExternalStore` bindings | protocol-specific hooks built on them |

## Cache semantics

`QueryCache<K>` is a map of entries, each carrying data plus the metadata that drives
reactivity. Four independent mechanisms interact; keeping them distinct is the whole
design:

**Staleness** is *advisory*. `staleTime` (default 30s) plus `invalidateTags` decide
when `isStale(key)` reports true — but stale data is never deleted, and nothing in the
core refetches. The adapter (or hook layer) reads `isStale` and decides whether to hit
the network; meanwhile the UI keeps rendering the stale value. Stale-while-revalidate
is the default posture. Non-`success` entries are always stale. A refetch marks the
entry via `setFetching` — entries with cached data keep status `"success"` (so the UI
never flashes a spinner over good data); errored entries go back to `"fetching"` but
keep `error` set so the last failure stays visible during the retry.

**GC** is *lifetime*, and it is driven by observation, not age. Every subscriber
ref-counts its entry; when the last observer leaves (or a write/patch/hydrate lands on
an unobserved entry), a `gcTime` timer (default 5min) arms. Any new subscriber disarms
it; entries with a live protocol subscription (`protocolSubscribed`) are never
collected. The timers are `unref`'d so cache housekeeping never holds a Node process
open. Staleness answers "should I refetch?"; gc answers "may I forget?".

**Tags** are the invalidation currency, RTK-Query style. A write declares tags
(`cache.write(key, data, { tags: [taskTag(agent, id)] })`); `invalidateTags` marks
every entry carrying any of them stale and emits. Two event hooks split local from
distributed concerns: `onInvalidate(keys)` fires only when entries were actually
touched (devtools, auto-refetch wiring); `onInvalidateTags(tags)` fires regardless —
it is the broadcast channel to other nodes (L2). The `broadcast=false` flag exists for
protocol-*driven* invalidations (each node receives its own push signal, so
re-broadcasting would loop). `entityTag("Issue", 1234)` is an opt-in convention for an
app-declared normalization layer on top.

**Structural sharing** protects render performance. A write whose data deep-equals the
cached data keeps the old reference, refreshes `updatedAt`, and does *not* bump the
entry's `version` — so a push notification whose bytes didn't change causes zero
re-renders. `version` is the value `useSyncExternalStore` observes; "no bump" *is* the
no-re-render guarantee. The same rule applies during `hydrate`.

Around those four: **keys are structured**, serialized once by the adapter's
`serializeKey` (exposed back as `cache.serializeKey()` — the React hook uses it so
inline keys never churn subscriptions). **Optimistic updates** (`patch`) apply a
recipe and hand back a rollback; patching a key with no real data creates a
provisional entry (status stays `"idle"` — a patch never claims server truth), and
rolling back removes such ghosts wholesale, unless a real write landed in between, in
which case rollback yields to the fresher data (see
[Optimistic flag semantics](#optimistic-flag-semantics) for the `isOptimistic`
marker that rides along). **Dehydrate/hydrate** round-trips
successful entries *with their original age*, so a restored snapshot's staleness math
still holds — and hydrate installs the preserved age before notifying subscribers.

## The broker model

Every agent protocol has moments where the machine must stop and ask a human: MCP's
sampling/elicitation, A2A's `INPUT_REQUIRED`/`AUTH_REQUIRED` paused states, ACP's
`session/request_permission`, AP2's mandates. They share a shape — pending request →
surface to UI → await approve/deny → resolve — so they share one machine instead of
each adapter re-rolling UI plumbing.

`InteractionBroker<D>` is three things in one:

1. **Policy** — a per-request trust function returning `"allow" | "deny" | "ask"`
   (default: ask everything). Auto verdicts never touch the queue.
2. **Queue** — pending interactions as a versioned reactive store; a UI binds with
   `useInteractions` and settles each with `resolve(id, decision)`. Concurrent
   interactions are independent and may resolve in any order.
3. **Audit** — an in-memory ring buffer (default 500) of every outcome
   (`auto-allow` / `auto-deny` / `approved` / `denied` / `error`), with fan-out sinks
   for durable logs.

`gate(type, peer, payload, opts)` is the composition adapters actually call: policy
first, then (on "ask") enqueue and await the human, recording the outcome either way.

**The decision-cast caveat** (read this if you extend `BaseDecision`): `gate`'s auto
paths must synthesize a decision, and the built-in fallbacks are bare
`{ action: "approve" }` / `{ action: "deny" }` objects **cast to `D`**. The type
system cannot check that cast against your extension — if `D` has *required* extra
fields, an auto verdict without an explicit `autoApprove`/`autoDeny` hands your
protocol handler an object missing them at runtime. Always pass `autoApprove` /
`autoDeny` when your decision type has required fields.

**Timeouts are opt-in.** By default a queued interaction waits forever — a deliberate
choice: the queue is UI state, and an unattended prompt should stay visible. When the
caller can't afford that (headless runs, protocol deadlines), pass
`timeoutMs`: on expiry the interaction is withdrawn from the queue, the audit trail
records outcome `"error"` with reason `"timeout"`, and the gate returns verdict
`"denied"` with the `autoDeny` decision (or `{ action: "deny", reason: "timeout" }`).

## The interceptor onion

`runInterceptors` is the server-side seam: a Koa/Connect-style chain around the
*logical* operation (read / call / send — whatever the adapter defines), not the
transport. Each interceptor receives the `Operation` and a `next`; it can mutate the
operation (context, args), short-circuit by returning or throwing without calling
`next`, or observe result/error/timing with try/finally around `next`. Authorization,
tracing, rate-limiting, and redaction all hang here. The `Operation` carries a
`state` scratch bag so interceptors can thread data down the chain (a span, a start
time) without inventing side channels.

Transport-level observation is a different tool: `instrumentTransport` wraps any
transport-shaped object in a structural Proxy that taps every message in both
directions for a wire log — no protocol SDK dependency, survives SDK upgrades.
Interceptors see *operations*; the tap sees *frames*.

## Devtools & persistence

`DevtoolsHub<TEvent>` is a ring-buffer event sink with fan-out — adapters emit
serializable, adapter-defined events; a panel subscribes and renders. `persistCache`
is the offline/restore story: hydrate from any synchronous storage on start,
debounce-save on change, best-effort (a full or unavailable storage never crashes the
app; the debounce timer is `unref`'d). `CacheStore` / `MemoryCacheStore` define the
async L2 tier behind the synchronous L1 — cross-instance sharing and distributed tag
invalidation for multi-node backends; the hot read path (hooks) never touches L2.

## Connectivity model

`StatusStore` adopts gRPC's channel connectivity state machine — the one piece of
connection UX gRPC got right enough that everyone copies it: a channel is always in
exactly one of IDLE / CONNECTING / READY / TRANSIENT_FAILURE / SHUTDOWN, and clients
watch *transitions*, not pings. Ours renames TRANSIENT_FAILURE to `"degraded"`
(unhealthy, connection layer still retrying) and SHUTDOWN to `"closed"` (terminal):
`idle | connecting | ready | degraded | closed`. Per state the store carries the
things a reconnection UI actually renders: `since` (stamped on state change only, so
"degraded for 40s" is answerable), `attempt` (consecutive tries, reset by reaching
`ready`), `lastError`, and `retryAt` ("retrying in 3s…").

Deliberately *not* a cache: peer status has no staleness, no gc, no tags — it is
always current truth about the connection layer, so it lives in a plain versioned
store (the broker's reactive pattern) that hooks observe via
`subscribe`/`getVersion`. Adapters own the transitions; the core owns the bookkeeping.

## Retry & idempotency contract

`withRetry` merges two industry lessons. From gRPC service config: retry policy is
*data* — `{ retries, baseDelayMs, maxDelayMs, factor, jitter, retryOn }` — declared
once, applied uniformly, with exponential backoff and full jitter
(`delay = random() * min(max, base * factor^attempt)`).

From Stripe's Idempotency-Key header: **retrying is a property the caller must
assert, never one the machinery may assume.** A retried mutation the peer already
processed is a duplicate side effect — double-send, double-charge, double-spawn.
Stripe's API refuses to make retries safe *for* you; it gives you a key mechanism
and makes you use it. `withRetry` does the same with `opts.idempotent`: anything but
exactly `true` means the first failure rethrows immediately. The canonical way to
earn the assertion is reusing the same message/request id on every attempt so the
peer can dedupe (`fn` receives the attempt number precisely so it *doesn't* need to
regenerate ids). Reads are naturally idempotent; mutations need the mechanism.

Backoff timers are `unref`'d (the same never-hold-the-process-open guard as the
cache gc timer), and an `AbortSignal` interrupts a pending delay promptly with the
abort reason — a cancelled agent call should not linger through a 30s backoff.

## Optimistic flag semantics

`CacheEntry.isOptimistic` is Firestore's `hasPendingWrites` transplanted: a boolean
that says "what you are rendering includes a local mutation the server has not
confirmed." `patch()` sets it; the next `write()` (server truth) or a rollback
clears it. Rules worth stating precisely:

- **Boolean, not a counter.** Overlapping patches share the flag; rolling back one
  patch restores the flag as it stood when *that* patch was applied, so an outer
  still-pending patch keeps it true.
- **The transition emits, always.** A confirming write whose bytes deep-equal the
  optimistic value would normally be silent under structural sharing — but the
  flag flip is observable state, so it bumps the version. No silent flag changes.
- **Never persisted.** `dehydrate` only captures server-confirmed entries, and a
  restored process has no pending mutation to confirm — `hydrate` always lands
  entries with `isOptimistic: false` (emitting if that clears a live flag).
- Ghost entries (patch-created, no prior data) die wholesale on rollback; the flag
  dies with them. A superseding write wins and has already cleared it.

## Triggers

TanStack Query's structural insight: staleness is a *predicate*, refetching needs an
*occasion*. The core keeps them separate — `isStale` answers "should I refetch?",
and a `Trigger` supplies "now would be a good time": window refocus
(`focusTrigger`), network restoration (`onlineTrigger`), or a polling interval
(`intervalTrigger(ms)`, unref'd). A trigger is just
`(fire: () => void) => unsubscribe` — an adapter can wrap a protocol push, a
webhook, or a message bus in four lines.

`wireRevalidation(cache, trigger, opts?)` is the composition: on fire, mark the
matching entries stale by key (`invalidateKeys` — `invalidateTags` semantics without
the tag index or the L2 broadcast, since keys are local vocabulary) and let
`events.onInvalidate` drive the adapter's refetch machinery. The default filter is
`subscribers > 0` — revalidate only what someone is watching; a supplied predicate
*replaces* that filter entirely rather than composing with it, so callers can
deliberately include unobserved entries.

## The devtools panel

`<AgentQueryDevtools>` (in `/react`) is the adoption lever: one drop-in component
that makes the invisible machinery visible — the hub's event timeline (newest first,
filterable by type), the cache table (key, status, stale, optimistic, subscribers,
age), the broker's pending interactions, and peer-status chips colored by
connectivity state. Zero dependencies, inline styles only, collapsible, fixed
bottom-right. `DevtoolsHub.getVersion()` exists so the panel (and any custom panel)
can bind with the same `useVersioned` pattern as every other store; the cache-wide
re-render rides `subscribeAll`, the global listener the persister already uses.

## Family rules

Cross-cutting contracts every `*-query` adapter must honor.

**Reconcile on stream resume.** The Kubernetes informer's ListAndWatch lesson: a
watch stream is an *optimization over* periodic relisting, never a replacement for
it. After any stream/subscription resume — reconnect, redeliver, wake-from-sleep —
the adapter MUST do a full read of the affected resources and reconcile the cache
against it. Never assume the gap was empty: the events you didn't receive are
exactly the ones you can't know about. Per-adapter reality:

- **mcpq** — relists: on reconnect it re-reads subscribed resources, so the cache
  reconverges to server truth.
- **a2aq** — polls, so it trivially reconciles: the next poll *is* the full read.
- **acpq** — has no replay: ACP session streams cannot be resumed with history, so
  a reconnect leaves session state gappy. Recovery is a fresh session or a
  re-prompt — the adapter must surface that honestly (mark the session degraded)
  rather than pretend the stream continued.

## How adapters bind — real usage

**a2a-query** ([`~/Projects/a2a-query`](https://github.com/johnhenry/a2a-query))
defines a two-kind key vocabulary and lets the core do the rest:

```ts
// keys.ts — the adapter's entire cache-key contract
export type A2AKey =
  | { kind: "card"; agent: string }
  | { kind: "task"; agent: string; taskId: string; partition?: string };
export const taskTag = (agent: string, taskId: string): Tag => `task:${agent}:${taskId}`;

// client.ts
this.cache = new QueryCache<A2AKey>({ serializeKey: serializeA2AKey });
```

Agent cards are cached with a 5-minute `staleTime`; task polling writes each snapshot
into the cache (structural sharing suppresses no-change poll renders); and when a task
enters a paused state, the adapter gates the resume through the broker with a decision
type that *carries the follow-up message*:

```ts
export interface InputDecision extends BaseDecision {
  message?: Message; // the resume payload — the human's answer rides the decision
}
const { decision } = await this.interactions.gate(type, agent, task);
```

**acp-query** ([`~/Projects/acp-query`](https://github.com/johnhenry/acp-query))
shows the other end of the spectrum: ACP is turn/stream-centric, so its cache is not a
query cache at all but a reactive session store — `session/update` notifications fold
into a `SessionState` under `{ kind: "session"; id }` keys. Same machinery, different
vocabulary. Its broker decision selects among protocol-offered permission options:

```ts
export interface PermissionDecision extends BaseDecision {
  optionId?: string; // which of the agent's offered options the human picked
}
const { decision } = await this.interactions.gate("permission", this.agentName, params, {
  autoApprove: { action: "approve", optionId: firstAllow?.optionId },
  autoDeny:    { action: "deny",    optionId: firstReject?.optionId },
});
```

Note both adapters pass explicit `autoApprove`/`autoDeny` where their decision fields
matter on the wire — the decision-cast caveat in practice.
