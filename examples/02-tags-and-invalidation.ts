// 02 · Tags & invalidation — RTK-Query-style declared tags, plus a simulated
// protocol push driving invalidation with broadcast suppressed.
// Run: npx tsx examples/02-tags-and-invalidation.ts   (no network)
//
// Tags are the invalidation currency: writes declare them, invalidateTags marks
// every carrier stale. onInvalidate fires only when entries were touched (local
// refetch wiring); onInvalidateTags is the broadcast channel to other nodes —
// and protocol-driven invalidations pass broadcast=false to avoid loops.

import { QueryCache, entityTag } from "../src/index.js";

type Key = { kind: "task" | "taskList"; agent: string; id?: string };

const cache = new QueryCache<Key>({
  serializeKey: (k) => JSON.stringify([k.kind, k.agent, k.id ?? ""]),
  events: {
    onInvalidate: (keys) => console.log("  [local]     stale entries:", keys),
    onInvalidateTags: (tags) => console.log("  [broadcast] tags to other nodes:", tags),
  },
});

// Writes declare what they provide:
cache.write({ kind: "task", agent: "planner", id: "42" }, { id: "42", state: "working" }, {
  tags: [entityTag("Task", 42)],
});
cache.write({ kind: "taskList", agent: "planner" }, ["42"], {
  tags: ["taskList:planner", entityTag("Task", 42)], // the list ALSO carries the entity tag
});

// ── a declared (app-level) invalidation: broadcasts ─────────────────────────
console.log("mutation completed → invalidateTags([Task:42]):");
cache.invalidateTags([entityTag("Task", 42)]);
console.log("  task stale?", cache.getSnapshot({ kind: "task", agent: "planner", id: "42" })?.isStale); // true
console.log("  list stale?", cache.getSnapshot({ kind: "taskList", agent: "planner" })?.isStale); // true

// ── a protocol-driven invalidation: each node gets its own push signal ──────
cache.write({ kind: "task", agent: "planner", id: "42" }, { id: "42", state: "done" }, {
  tags: [entityTag("Task", 42)],
}); // refetch landed — fresh again
console.log("push notification from the wire → invalidateTags(…, broadcast=false):");
cache.invalidateTags([entityTag("Task", 42)], false); // note: no [broadcast] line below
console.log("  task stale again?", cache.getSnapshot({ kind: "task", agent: "planner", id: "42" })?.isStale);

// ── unknown tags are silent no-ops locally ──────────────────────────────────
console.log("invalidating a tag nothing carries (only the broadcast fires):");
cache.invalidateTags(["nothing:carries-this"]);
