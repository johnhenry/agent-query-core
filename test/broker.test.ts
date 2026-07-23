import { describe, it, expect, vi } from "vitest";
import { InteractionBroker, type BaseDecision } from "../src/broker.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next pending interaction, then settle it. */
async function settleNext<D extends BaseDecision>(broker: InteractionBroker<D>, decision: D) {
  for (let i = 0; i < 100; i++) {
    const [next] = broker.list();
    if (next) {
      broker.resolve(next.id, decision);
      return next;
    }
    await tick();
  }
  throw new Error("no interaction appeared");
}

describe("InteractionBroker gate", () => {
  it('"allow" auto-approves without queuing', async () => {
    const broker = new InteractionBroker({ policy: () => "allow" });
    const { verdict, decision } = await broker.gate("permission", "peer1", { q: 1 });
    expect(verdict).toBe("auto-allow");
    expect(decision.action).toBe("approve");
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog().at(-1)).toMatchObject({ peer: "peer1", type: "permission", outcome: "auto-allow" });
  });

  it('"deny" auto-rejects without queuing (custom autoDeny decision carried)', async () => {
    type D = BaseDecision & { code?: string };
    const broker = new InteractionBroker<D>({ policy: () => "deny" });
    const { verdict, decision } = await broker.gate("input-required", "peer1", {}, { autoDeny: { action: "deny", code: "policy" } });
    expect(verdict).toBe("auto-deny");
    expect(decision.code).toBe("policy");
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
  });

  it('"ask" (default) queues for a human and returns the UI decision', async () => {
    type D = BaseDecision & { content?: unknown };
    const broker = new InteractionBroker<D>();
    const p = broker.gate("input-required", "agentA", { prompt: "name?" });
    const pending = await settleNext<D>(broker, { action: "approve", content: { name: "Ada" } });
    expect(pending.type).toBe("input-required");
    expect(pending.peer).toBe("agentA");
    const { verdict, decision } = await p;
    expect(verdict).toBe("approved");
    expect(decision.content).toEqual({ name: "Ada" });
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
  });

  it("deny from the UI records 'denied' with the reason", async () => {
    const broker = new InteractionBroker();
    const p = broker.gate("mandate", "merchant", {});
    await settleNext(broker, { action: "deny", reason: "too expensive" });
    const { verdict } = await p;
    expect(verdict).toBe("denied");
    expect(broker.auditLog().at(-1)).toMatchObject({ outcome: "denied", reason: "too expensive" });
  });
});

describe("broker plumbing", () => {
  it("audit ring caps at capacity and fans out to sinks", () => {
    const sink = vi.fn();
    const broker = new InteractionBroker({ auditCapacity: 2 });
    broker.addAuditSink(sink);
    broker.record("p", "t", "approved");
    broker.record("p", "t", "denied");
    broker.record("p", "t", "error");
    expect(broker.auditLog()).toHaveLength(2);
    expect(broker.auditLog().map((e) => e.outcome)).toEqual(["denied", "error"]);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("subscribe/getVersion bump on queue changes; manual flag surfaces", async () => {
    const broker = new InteractionBroker();
    const versions: number[] = [];
    broker.subscribe(() => versions.push(broker.getVersion()));
    const p = broker.enqueue("consent", "request", "peer", { x: 1 }, true);
    expect(broker.list()[0]?.manual).toBe(true);
    broker.resolve(broker.list()[0]!.id, { action: "approve" });
    await p;
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it("resolving an unknown id is a no-op", () => {
    const broker = new InteractionBroker();
    expect(() => broker.resolve(999, { action: "approve" })).not.toThrow();
  });
});
