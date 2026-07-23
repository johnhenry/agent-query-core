import { describe, it, expect, vi } from "vitest";
import { StatusStore } from "../src/status.js";

describe("StatusStore", () => {
  it("stores and merges peer status, bumping the version on every set", () => {
    let t = 100;
    const store = new StatusStore({ now: () => t });
    expect(store.getVersion()).toBe(0);
    expect(store.get("mcp:files")).toBeUndefined();

    store.set("mcp:files", { state: "connecting", attempt: 1 });
    expect(store.getVersion()).toBe(1);
    expect(store.get("mcp:files")).toEqual({
      state: "connecting",
      since: 100,
      attempt: 1,
      lastError: undefined,
      retryAt: undefined,
    });

    // Merge: same state, new attempt — version bumps, since preserved.
    t = 200;
    store.set("mcp:files", { state: "connecting", attempt: 2, retryAt: 450 });
    expect(store.getVersion()).toBe(2);
    expect(store.get("mcp:files")).toMatchObject({ since: 100, attempt: 2, retryAt: 450 });
  });

  it("stamps `since` on state CHANGE only", () => {
    let t = 0;
    const store = new StatusStore({ now: () => t });
    store.set("a", { state: "idle" });
    t = 50;
    store.set("a", { state: "idle" }); // no change → since stays 0
    expect(store.get("a")!.since).toBe(0);
    t = 75;
    store.set("a", { state: "connecting" }); // change → restamped
    expect(store.get("a")!.since).toBe(75);
  });

  it("resets attempt to 0 on transition to ready (even if a value is supplied)", () => {
    const store = new StatusStore({ now: () => 1 });
    const err = new Error("refused");
    store.set("p", { state: "connecting", attempt: 3, lastError: err });
    store.set("p", { state: "ready", attempt: 99 });
    expect(store.get("p")).toMatchObject({ state: "ready", attempt: 0, lastError: err });
    // Merging while ALREADY ready does not force the reset.
    store.set("p", { state: "ready", attempt: 7 });
    expect(store.get("p")!.attempt).toBe(7);
  });

  it("merges lastError/retryAt but lets explicit undefined clear them", () => {
    const store = new StatusStore({ now: () => 1 });
    const err = new Error("boom");
    store.set("p", { state: "degraded", lastError: err, retryAt: 900 });
    store.set("p", { state: "degraded", attempt: 2 }); // omitted → preserved
    expect(store.get("p")).toMatchObject({ lastError: err, retryAt: 900 });
    store.set("p", { state: "degraded", lastError: undefined, retryAt: undefined }); // explicit → cleared
    expect(store.get("p")!.lastError).toBeUndefined();
    expect(store.get("p")!.retryAt).toBeUndefined();
  });

  it("subscribe notifies on set and remove; unsubscribe stops it; remove of unknown peer is silent", () => {
    const store = new StatusStore();
    const fn = vi.fn();
    const un = store.subscribe(fn);
    store.set("p", { state: "idle" });
    expect(fn).toHaveBeenCalledTimes(1);
    store.remove("p");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(store.get("p")).toBeUndefined();
    const v = store.getVersion();
    store.remove("p"); // already gone → no bump, no notify
    expect(store.getVersion()).toBe(v);
    expect(fn).toHaveBeenCalledTimes(2);
    un();
    store.set("p", { state: "idle" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("list() returns all peers as [name, status] pairs", () => {
    const store = new StatusStore({ now: () => 5 });
    store.set("a", { state: "ready" });
    store.set("b", { state: "closed" });
    const list = store.list();
    expect(list.map(([n]) => n).sort()).toEqual(["a", "b"]);
    expect(Object.fromEntries(list).a!.state).toBe("ready");
  });
});
