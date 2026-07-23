// @vitest-environment happy-dom
// <AgentQueryDevtools> smoke tests — real renders on happy-dom.

import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";

afterEach(cleanup);
import { QueryCache, InteractionBroker, DevtoolsHub, StatusStore } from "../src/index.js";
import { AgentQueryDevtools, usePeerStatus } from "../src/react/index.js";
import { focusTrigger, onlineTrigger } from "../src/triggers.js";

const setup = () => {
  const hub = new DevtoolsHub();
  const cache = new QueryCache<string>({ serializeKey: (k) => k });
  const broker = new InteractionBroker();
  const status = new StatusStore();
  return { hub, cache, broker, status };
};

describe("AgentQueryDevtools", () => {
  it("starts collapsed by default and opens via the toggle button", () => {
    const { hub } = setup();
    render(<AgentQueryDevtools hub={hub} />);
    expect(screen.queryByTestId("agent-query-devtools")).toBeNull();
    fireEvent.click(screen.getByLabelText("Open agent-query devtools"));
    expect(screen.getByTestId("agent-query-devtools")).toBeTruthy();
  });

  it("renders hub events newest-first, live, and filters by type", () => {
    const { hub } = setup();
    hub.emit({ type: "cache:write", key: "a" });
    hub.emit({ type: "broker:gate", peer: "p" });
    const { container } = render(<AgentQueryDevtools hub={hub} defaultOpen />);
    let rows = Array.from(container.querySelectorAll('[data-testid="event-row"]')).map((d) => d.textContent);
    expect(rows[0]).toContain("broker:gate"); // newest first
    expect(rows.some((r) => r?.includes("cache:write"))).toBe(true);

    act(() => hub.emit({ type: "cache:invalidate", keys: ["a"] })); // live update
    expect(container.textContent).toContain("cache:invalidate");

    fireEvent.change(screen.getByLabelText("Filter events by type"), { target: { value: "broker" } });
    rows = Array.from(container.querySelectorAll('[data-testid="event-row"]')).map((d) => d.textContent);
    expect(rows.join("\n")).toContain("broker:gate");
    expect(rows.join("\n")).not.toContain("cache:write");
  });

  it("cache table shows status, staleness, isOptimistic, and subscribers — reactively", () => {
    const { hub, cache } = setup();
    cache.write("doc:a", { n: 1 });
    render(<AgentQueryDevtools hub={hub} cache={cache} defaultOpen />);
    const row = () => screen.getByTestId("cache-row-doc:a").textContent!;
    expect(row()).toContain("success");
    expect(row()).toMatch(/no.*no/); // not stale, not optimistic
    act(() => cache.patch([{ key: "doc:a", recipe: () => ({ n: 2 }) }]));
    expect(row()).toContain("yes"); // isOptimistic now shown
    act(() => cache.write("doc:a", { n: 2 }));
    expect(row()).not.toContain("yes");
  });

  it("shows pending interactions and peer chips colored by state", async () => {
    const { hub, broker, status } = setup();
    status.set("mcp:files", { state: "degraded", attempt: 3 });
    render(<AgentQueryDevtools hub={hub} broker={broker} status={status} defaultOpen />);
    expect(screen.getByTestId("peer-mcp:files").textContent).toContain("degraded");
    expect(screen.getByTestId("peer-mcp:files").textContent).toContain("×3");

    let decided: Promise<unknown>;
    act(() => {
      decided = broker.enqueue("permission", "request", "acp:agent", { tool: "fs/write" });
    });
    expect(screen.getByTestId("interaction-1").textContent).toContain("permission");
    expect(screen.getByText(/pending interactions \(1\)/)).toBeTruthy();
    act(() => broker.resolve(1, { action: "deny" }));
    await decided!;
    expect(screen.queryByTestId("interaction-1")).toBeNull();
  });
});

describe("usePeerStatus", () => {
  it("returns one peer's status, or the full list when peer is omitted — reactively", () => {
    const store = new StatusStore({ now: () => 42 });
    function Probe() {
      const one = usePeerStatus(store, "a");
      const all = usePeerStatus(store);
      return (
        <div data-testid="probe">
          {one?.state ?? "none"}|{all.length}
        </div>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("none|0");
    act(() => store.set("a", { state: "connecting" }));
    expect(screen.getByTestId("probe").textContent).toBe("connecting|1");
    act(() => store.set("b", { state: "ready" }));
    expect(screen.getByTestId("probe").textContent).toBe("connecting|2");
  });
});

describe("focusTrigger / onlineTrigger in a DOM", () => {
  it("focusTrigger fires on window focus and visible visibilitychange, and unsubscribes", () => {
    let fires = 0;
    const un = focusTrigger(() => fires++);
    window.dispatchEvent(new Event("focus"));
    expect(fires).toBe(1);
    document.dispatchEvent(new Event("visibilitychange")); // happy-dom is "visible"
    expect(fires).toBe(2);
    un();
    window.dispatchEvent(new Event("focus"));
    expect(fires).toBe(2);
  });

  it("onlineTrigger fires on window online, and unsubscribes", () => {
    let fires = 0;
    const un = onlineTrigger(() => fires++);
    window.dispatchEvent(new Event("online"));
    expect(fires).toBe(1);
    un();
    window.dispatchEvent(new Event("online"));
    expect(fires).toBe(1);
  });
});
