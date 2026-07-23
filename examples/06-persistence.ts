// 06 · Persistence — dehydrate/hydrate across "sessions", and persistCache
// keeping a cache saved to an in-memory storage shim.
// Run: npx tsx examples/06-persistence.ts   (no network; fake localStorage)
//
// dehydrate() captures successful entries WITH their age; hydrate() restores
// them so staleness math still applies. persistCache automates the loop:
// hydrate on start, debounce-save on change, best-effort.

import { QueryCache, persistCache, type SyncStorage } from "../src/index.js";

// A localStorage stand-in (any synchronous key/value store works):
const backing = new Map<string, string>();
const storage: SyncStorage = {
  getItem: (k) => backing.get(k) ?? null,
  setItem: (k, v) => void backing.set(k, v),
};

let now = 1_000;
const clock = { now: () => now, serializeKey: (k: string) => k };

// ── session one: populate, auto-save ────────────────────────────────────────
console.log("session one:");
const first = new QueryCache<string>(clock);
const stop1 = persistCache(first, storage, { debounce: 10 });
first.write("profile", { name: "Ada" }, { tags: ["profile"], staleTime: 60_000 });
first.write("drafts", ["untitled-1"], { tags: ["drafts"] });
await new Promise((r) => setTimeout(r, 30)); // let the debounce flush
stop1();
console.log("  saved bytes:", backing.get("agent-query-cache")!.length);

// ── session two: a fresh process hydrates and keeps the ORIGINAL age ────────
now = 45_000; // 44s later
console.log("session two (44s later):");
const second = new QueryCache<string>(clock);
const stop2 = persistCache(second, storage, { debounce: 10 });
console.log("  profile:", second.getSnapshot("profile")?.data, "— restored");
console.log("  updatedAt preserved:", second.getSnapshot("profile")?.updatedAt, "(not", clock.now() + ")");
console.log("  stale? (60s staleTime …but hydrate uses defaults; age still counts):", second.isStale("profile"));

// ── writes in session two keep the snapshot current ─────────────────────────
second.write("drafts", ["untitled-1", "untitled-2"], { tags: ["drafts"] });
await new Promise((r) => setTimeout(r, 30));
stop2();
const final = JSON.parse(backing.get("agent-query-cache")!) as { entries: { cacheKey: string }[] };
console.log("  final snapshot keys:", final.entries.map((e) => e.cacheKey));

// ── stop() means stop: later writes are not persisted ───────────────────────
second.write("scratch", "never saved");
await new Promise((r) => setTimeout(r, 30));
console.log("  after stop(), snapshot still has", (JSON.parse(backing.get("agent-query-cache")!) as { entries: unknown[] }).entries.length, "entries");
