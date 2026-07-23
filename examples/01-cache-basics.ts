// 01 · Cache basics — write, read, staleness, and subscription.
// Run: npx tsx examples/01-cache-basics.ts   (no network; injectable clock)
//
// The QueryCache is generic over YOUR structured key type — you supply the
// serializer, it supplies staleness, gc, reactivity.

import { QueryCache } from "../src/index.js";

type Key = { kind: "doc"; id: string };

let now = 0; // injectable clock so staleness is demonstrable without sleeping
const cache = new QueryCache<Key>({
  serializeKey: (k) => JSON.stringify([k.kind, k.id]),
  now: () => now,
});

// ── write & read ────────────────────────────────────────────────────────────
cache.write({ kind: "doc", id: "readme" }, { title: "Hello", words: 120 }, { staleTime: 30_000 });
const entry = cache.getSnapshot({ kind: "doc", id: "readme" })!;
console.log("data:", entry.data); // { title: 'Hello', words: 120 }
console.log("status:", entry.status); // success

// ── staleness is advisory: data stays renderable, isStale() flips ───────────
console.log("stale at t=0?", cache.isStale({ kind: "doc", id: "readme" })); // false
now += 31_000;
console.log("stale at t=31s?", cache.isStale({ kind: "doc", id: "readme" })); // true
console.log("data still cached:", cache.getSnapshot({ kind: "doc", id: "readme" })?.data); // unchanged

// ── subscription: notified per change, version drives re-renders ────────────
const un = cache.subscribe({ kind: "doc", id: "readme" }, () => {
  const e = cache.getSnapshot({ kind: "doc", id: "readme" })!;
  console.log(`notified → version ${e.version}, words = ${(e.data as { words: number }).words}`);
});
cache.write({ kind: "doc", id: "readme" }, { title: "Hello", words: 240 }); // notified
cache.write({ kind: "doc", id: "readme" }, { title: "Hello", words: 240 }); // deep-equal → SILENT (structural sharing)
un();
console.log("done — the equal rewrite produced no notification.");
