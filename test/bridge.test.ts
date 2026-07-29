import { describe, it, expect } from "vitest";
import { tagToQueryKey, keyToQueryKey, QUERY_KEY_NAMESPACE } from "../src/bridge.js";
import { entityTag } from "../src/cache.js";

describe("QUERY_KEY_NAMESPACE", () => {
  it("is pinned to 'agent-query' (bridge packages hard-depend on this matching)", () => {
    expect(QUERY_KEY_NAMESPACE).toBe("agent-query");
  });
});

describe("tagToQueryKey", () => {
  it("translates a single-segment tag (no colon)", () => {
    expect(tagToQueryKey("server:x")).toEqual(["agent-query", "server", "x"]);
  });

  it("translates a multi-colon tag, per the issue's own example", () => {
    expect(tagToQueryKey("tool:server.name")).toEqual(["agent-query", "tool", "server.name"]);
  });

  it("round-trips entityTag output", () => {
    expect(tagToQueryKey(entityTag("Issue", 1234))).toEqual(["agent-query", "Issue", "1234"]);
  });
});

describe("keyToQueryKey", () => {
  it("namespaces under a fixed 'key' segment with the serialized leaf", () => {
    const serializeKey = (k: { id: string }) => `doc:${k.id}`;
    expect(keyToQueryKey(serializeKey, { id: "42" })).toEqual(["agent-query", "key", "doc:42"]);
  });
});
