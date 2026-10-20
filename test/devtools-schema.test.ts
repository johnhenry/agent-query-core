import { describe, it, expect } from "vitest";
import {
  DevtoolsHub,
  DEVTOOLS_SCHEMA_VERSION,
  toSerializableEvent,
  parseDevtoolsSnapshot,
  summarizeTraffic,
  type TrafficEvent,
} from "../src/index.js";

describe("devtools schema", () => {
  it("exposes an integer schema version", () => {
    expect(Number.isInteger(DEVTOOLS_SCHEMA_VERSION)).toBe(true);
    expect(DEVTOOLS_SCHEMA_VERSION).toBe(1);
  });

  it("snapshot() is versioned and survives a JSON round trip", () => {
    const hub = new DevtoolsHub();
    hub.emit({ type: "cache:write", key: ["a", 1] });
    hub.emit({ type: "x", nested: { ok: true } });
    const snap = hub.snapshot();
    expect(snap.version).toBe(DEVTOOLS_SCHEMA_VERSION);
    expect(snap.events).toHaveLength(2);
    const parsed = parseDevtoolsSnapshot(JSON.stringify(snap));
    expect(parsed).toEqual(snap);
  });

  it("toSerializableEvent makes odd values JSON-safe", () => {
    const cyc: Record<string, unknown> = { n: 1 };
    cyc.self = cyc;
    const out = toSerializableEvent({
      type: "t",
      big: 10n,
      err: new TypeError("boom"),
      fn: () => 1,
      undef: undefined,
      when: new Date(0),
      cyc,
      map: new Map([["k", 1]]),
      set: new Set([1]),
    }) as Record<string, any>;
    const text = JSON.stringify(out);
    expect(JSON.parse(text)).toEqual(out);
    expect(out.type).toBe("t");
    expect(out.big).toBe("10");
    expect(out.err).toMatchObject({ name: "TypeError", message: "boom" });
    expect(out.fn).toBeUndefined();
    expect(out.when).toBe("1970-01-01T00:00:00.000Z");
    expect(out.cyc.self).toBe("[Circular]");
    expect(out.map).toEqual([["k", 1]]);
    expect(out.set).toEqual([1]);
  });

  it("snapshot() sanitizes events without mutating the buffer", () => {
    const hub = new DevtoolsHub();
    hub.emit({ type: "t", big: 5n });
    expect(() => JSON.stringify(hub.snapshot())).not.toThrow();
    expect(hub.events()[0]!.big).toBe(5n);
  });

  it("parse rejects a newer major version and malformed input", () => {
    expect(() => parseDevtoolsSnapshot(JSON.stringify({ version: DEVTOOLS_SCHEMA_VERSION + 1, events: [] }))).toThrow(
      /version/,
    );
    expect(() => parseDevtoolsSnapshot("{}")).toThrow();
    expect(() => parseDevtoolsSnapshot(JSON.stringify({ version: 1, events: [{ nope: 1 }] }))).toThrow(/type/);
    expect(() => parseDevtoolsSnapshot("not json")).toThrow();
  });
});

describe("summarizeTraffic (bodyless wire summaries)", () => {
  const sum = (message: TrafficEvent["message"], dir: "in" | "out" = "out") => summarizeTraffic({ dir, message });
  it("classifies request / notification / response / error and drops bodies", () => {
    expect(sum({ method: "tools/call", id: 3, params: { secret: "x" } })).toEqual({
      type: "wire",
      dir: "out",
      kind: "request",
      method: "tools/call",
      id: 3,
    });
    expect(sum({ method: "notifications/x", params: { a: 1 } }, "in")).toEqual({
      type: "wire",
      dir: "in",
      kind: "notification",
      method: "notifications/x",
    });
    expect(sum({ id: 3, result: { big: "payload" } }, "in")).toEqual({ type: "wire", dir: "in", kind: "response", id: 3 });
    expect(sum({ id: 4, error: { code: -1, message: "nope" } }, "in")).toEqual({
      type: "wire",
      dir: "in",
      kind: "error",
      id: 4,
      errorCode: -1,
    });
  });
  it("never includes params/result/error bodies", () => {
    const s = JSON.stringify(sum({ method: "m", id: 1, params: { token: "SECRET" }, result: "SECRET" }));
    expect(s).not.toContain("SECRET");
  });
});
