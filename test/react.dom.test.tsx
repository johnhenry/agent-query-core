// @vitest-environment happy-dom
// React binding tests — real renders via @testing-library/react on happy-dom.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { useRef } from "react";

afterEach(cleanup);
import { QueryCache, InteractionBroker, DevtoolsHub, type BaseDecision } from "../src/index.js";
import { useCacheEntry, useInteractions, useAuditLog, useVersioned } from "../src/react/index.js";

type Key = { kind: string; id: string };
const makeCache = (events?: ConstructorParameters<typeof QueryCache<Key>>[0]["events"]) =>
  new QueryCache<Key>({ serializeKey: (k) => JSON.stringify([k.kind, k.id]), events });

describe("useCacheEntry", () => {
  it("re-renders when the observed entry is written", () => {
    const cache = makeCache();
    function Doc() {
      const entry = useCacheEntry(cache, { kind: "doc", id: "a" });
      return <div data-testid="doc">{entry?.status === "success" ? String(entry.data) : "empty"}</div>;
    }
    render(<Doc />);
    expect(screen.getByTestId("doc").textContent).toBe("empty");
    act(() => cache.write({ kind: "doc", id: "a" }, "hello"));
    expect(screen.getByTestId("doc").textContent).toBe("hello");
    act(() => cache.write({ kind: "doc", id: "a" }, "world"));
    expect(screen.getByTestId("doc").textContent).toBe("world");
  });

  it("does NOT re-render on a structurally-equal rewrite", () => {
    const cache = makeCache();
    let renders = 0;
    function Doc() {
      renders++;
      const entry = useCacheEntry(cache, { kind: "doc", id: "a" });
      return <span>{JSON.stringify(entry?.data ?? null)}</span>;
    }
    render(<Doc />);
    act(() => cache.write({ kind: "doc", id: "a" }, { list: [1, 2] }));
    const after = renders;
    act(() => cache.write({ kind: "doc", id: "a" }, { list: [1, 2] })); // deep-equal
    expect(renders).toBe(after);
  });

  it("inline keys (fresh object identity each render) do not cause resubscribe churn", () => {
    const onSubscribe = vi.fn();
    const onUnsubscribe = vi.fn();
    const cache = makeCache({ onSubscribe, onUnsubscribe });
    function Doc({ tick }: { tick: number }) {
      // A NEW key object on every render — only its serialized form is stable.
      const entry = useCacheEntry(cache, { kind: "doc", id: "a" });
      return (
        <span>
          {tick}:{String(entry?.data ?? "-")}
        </span>
      );
    }
    const { rerender } = render(<Doc tick={1} />);
    rerender(<Doc tick={2} />);
    rerender(<Doc tick={3} />);
    expect(onSubscribe).toHaveBeenCalledTimes(1); // subscribed once, never churned
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it("unmount releases the subscription (last-observer gc handoff)", () => {
    const onUnsubscribe = vi.fn();
    const cache = makeCache({ onUnsubscribe });
    function Doc() {
      useCacheEntry(cache, { kind: "doc", id: "a" });
      return null;
    }
    const { unmount } = render(<Doc />);
    unmount();
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("useInteractions", () => {
  type D = BaseDecision & { content?: string };

  it("shows queued interactions and resolves them from the UI", async () => {
    const broker = new InteractionBroker<D>();
    function Prompts() {
      const { interactions, resolve } = useInteractions(broker);
      return (
        <div>
          <span data-testid="count">{interactions.length}</span>
          {interactions.map((i) => (
            <button key={i.id} data-testid={`approve-${i.id}`} onClick={() => resolve(i.id, { action: "approve", content: "yes" })}>
              approve {i.type}
            </button>
          ))}
        </div>
      );
    }
    render(<Prompts />);
    expect(screen.getByTestId("count").textContent).toBe("0");

    let settled: D | undefined;
    act(() => {
      void broker.enqueue("consent", "request", "peerX", { q: "?" }).then((d) => (settled = d));
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    const id = broker.list()[0]!.id;
    act(() => screen.getByTestId(`approve-${id}`).click());
    await act(async () => {}); // flush the microtask settling the gate promise
    expect(settled).toEqual({ action: "approve", content: "yes" });
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("tolerates an undefined broker (renders empty, resolve is a no-op)", () => {
    function Prompts() {
      const { interactions, resolve } = useInteractions<BaseDecision>(undefined);
      resolve(1, { action: "approve" });
      return <span data-testid="n">{interactions.length}</span>;
    }
    render(<Prompts />);
    expect(screen.getByTestId("n").textContent).toBe("0");
  });
});

describe("useAuditLog", () => {
  it("re-renders as audit entries land", () => {
    const broker = new InteractionBroker();
    function Audit() {
      const log = useAuditLog(broker);
      return <span data-testid="log">{log.map((e) => e.outcome).join(",")}</span>;
    }
    render(<Audit />);
    act(() => broker.record("p", "t", "auto-allow"));
    act(() => broker.record("p", "t", "denied", "nope"));
    expect(screen.getByTestId("log").textContent).toBe("auto-allow,denied");
  });

  it("returns an empty log for an undefined broker", () => {
    function Audit() {
      const log = useAuditLog(undefined);
      return <span data-testid="log">{log.length}</span>;
    }
    render(<Audit />);
    expect(screen.getByTestId("log").textContent).toBe("0");
  });
});

describe("useVersioned", () => {
  it("re-renders when any versioned store bumps (DevtoolsHub-style adapter)", () => {
    const hub = new DevtoolsHub<{ type: string }>();
    // DevtoolsHub has no getVersion — adapt with a counter, the documented pattern.
    let version = 0;
    hub.subscribe(() => version++);
    function Panel() {
      const countRef = useRef(0);
      useVersioned((fn) => hub.subscribe(fn), () => version);
      countRef.current = hub.events().length;
      return <span data-testid="n">{countRef.current}</span>;
    }
    render(<Panel />);
    act(() => hub.emit({ type: "a" }));
    act(() => hub.emit({ type: "b" }));
    expect(screen.getByTestId("n").textContent).toBe("2");
  });
});
