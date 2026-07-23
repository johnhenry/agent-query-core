// 07 · Connection status — a flaky peer walked through the gRPC-style state machine.
// Run: npx tsx examples/07-connection-status.ts   (no network; injectable clock)
//
// The StatusStore is a versioned reactive store of per-peer connectivity:
// idle → connecting → ready → degraded → … → ready. `since` restamps only on
// state CHANGE, `attempt` counts consecutive tries and resets on ready, and a
// subscription (or usePeerStatus in React) observes every set.

import { StatusStore } from "../src/index.js";

let now = 0; // injectable clock — transitions are demonstrable without sleeping
const status = new StatusStore({ now: () => now });

const unsubscribe = status.subscribe(() => {
  const s = status.get("mcp:files")!;
  const bits = [
    `state=${s.state}`,
    `since=t+${s.since}ms`,
    `attempt=${s.attempt}`,
    s.retryAt !== undefined ? `retryAt=t+${s.retryAt}ms` : null,
    s.lastError ? `lastError="${s.lastError.message}"` : null,
  ].filter(Boolean);
  console.log(`[v${status.getVersion()}] ${bits.join("  ")}`);
});

// ── the peer's life ─────────────────────────────────────────────────────────
status.set("mcp:files", { state: "connecting", attempt: 1 });

now = 120; // handshake done
status.set("mcp:files", { state: "ready" }); // attempt resets to 0 on ready

now = 5_000; // transport drops; the connection layer starts retrying
status.set("mcp:files", {
  state: "degraded",
  attempt: 1,
  lastError: new Error("ECONNRESET"),
  retryAt: 5_200,
});

now = 5_200; // retry #2 — same state, so `since` stays at 5000
status.set("mcp:files", { state: "degraded", attempt: 2, retryAt: 5_600 });

now = 5_600; // retry #3 succeeds
status.set("mcp:files", { state: "ready", lastError: undefined, retryAt: undefined });

unsubscribe();
console.log("\nfinal:", status.list());
console.log("(note: since restamped only on state change; attempt reset by ready)");
