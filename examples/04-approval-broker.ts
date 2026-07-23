// 04 · Approval broker — policy allow/deny/ask, a simulated UI resolving the
// queue, and the audit printout.
// Run: npx tsx examples/04-approval-broker.ts   (no network)
//
// One machine for every human-in-the-loop decision point. The policy answers
// per request; only "ask" reaches the queue, where a UI (here: a subscriber
// acting as one) settles each interaction. Every outcome lands in the audit ring.

import { InteractionBroker, type BaseDecision } from "../src/index.js";

// A protocol-specific decision: the human's answer rides extra fields.
interface ToolDecision extends BaseDecision {
  editedArgs?: Record<string, unknown>;
}

const broker = new InteractionBroker<ToolDecision>({
  policy: ({ peer, type }) => {
    if (peer === "trusted-server") return "allow"; // silent
    if (type === "dangerous") return "deny"; // silent
    return "ask"; // queue for the human
  },
});

// ── the simulated UI: watches the queue, approves writes after "review" ─────
broker.subscribe(() => {
  for (const i of broker.list()) {
    console.log(`  [ui] prompt: ${i.peer} wants "${i.type}" with`, i.payload);
    broker.resolve(i.id, { action: "approve", editedArgs: { path: "/tmp/safe.txt" } });
  }
});

// ── three gates, three paths ────────────────────────────────────────────────
console.log("gate 1 — trusted peer (policy: allow):");
console.log(" ", await broker.gate("tool-call", "trusted-server", { tool: "read" }));

console.log("gate 2 — dangerous type (policy: deny). NOTE the autoDeny option: when your");
console.log("         decision type has required fields, you MUST pass autoApprove/autoDeny —");
console.log("         the built-in fallbacks are bare {action} objects cast to your type.");
console.log(" ", await broker.gate("dangerous", "sketchy", {}, { autoDeny: { action: "deny", reason: "policy" } }));

console.log("gate 3 — ask → queued → the UI approves (with edited args):");
console.log(" ", await broker.gate("tool-call", "new-server", { tool: "write", path: "/etc/passwd" }));

// ── a gate nobody answers, bounded by timeoutMs ─────────────────────────────
const silent = new InteractionBroker(); // no UI attached, default policy: ask
console.log("gate 4 — unattended queue with timeoutMs: 100:");
console.log(" ", await silent.gate("consent", "peer", {}, { timeoutMs: 100 }));

// ── the audit trail ─────────────────────────────────────────────────────────
console.log("\naudit trail:");
for (const e of [...broker.auditLog(), ...silent.auditLog()]) {
  console.log(`  #${e.id} ${e.peer.padEnd(14)} ${e.type.padEnd(10)} → ${e.outcome}${e.reason ? ` (${e.reason})` : ""}`);
}
