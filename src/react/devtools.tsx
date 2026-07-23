// <AgentQueryDevtools> — a zero-dependency, inline-styled floating panel:
// event timeline (DevtoolsHub), cache entry table, pending interactions, and
// peer-status chips. Drop it anywhere in the tree during development; every
// section is optional — pass only the stores you have.

import { useEffect, useMemo, useReducer, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { DevtoolsHub } from "../devtools.js";
import type { QueryCache } from "../cache.js";
import type { InteractionBroker } from "../broker.js";
import type { StatusStore, ConnectivityState } from "../status.js";
import { useVersioned } from "./index.js";

const STATE_COLORS: Record<ConnectivityState, string> = {
  idle: "#8a8f98",
  connecting: "#e5c07b",
  ready: "#98c379",
  degraded: "#e06c75",
  closed: "#5c6370",
};

const panel: CSSProperties = {
  position: "fixed",
  bottom: 12,
  right: 12,
  zIndex: 99999,
  width: 420,
  maxHeight: "60vh",
  overflow: "auto",
  background: "#1e2127",
  color: "#abb2bf",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  border: "1px solid #3a3f4b",
  borderRadius: 6,
  padding: 8,
  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
};
const toggle: CSSProperties = {
  position: "fixed",
  bottom: 12,
  right: 12,
  zIndex: 100000,
  background: "#282c34",
  color: "#98c379",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  border: "1px solid #3a3f4b",
  borderRadius: 6,
  padding: "4px 8px",
  cursor: "pointer",
};
const h: CSSProperties = { color: "#61afef", margin: "8px 0 4px", fontSize: 11, fontWeight: 600 };
const cell: CSSProperties = { padding: "1px 6px 1px 0", textAlign: "left", whiteSpace: "nowrap" };

export interface AgentQueryDevtoolsProps {
  hub: DevtoolsHub;
  cache?: QueryCache<any>;
  broker?: InteractionBroker<any>;
  status?: StatusStore;
  title?: string;
  defaultOpen?: boolean;
}

export function AgentQueryDevtools(props: AgentQueryDevtoolsProps): JSX.Element {
  const { hub, cache, broker, status, title = "agent-query", defaultOpen = false } = props;
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState("");
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Hub / broker / status are versioned stores; the cache re-renders via its
  // global listener (subscribeAll fires on any change to any entry).
  useVersioned((fn) => hub.subscribe(fn), () => hub.getVersion());
  useVersioned((fn) => (broker ? broker.subscribe(fn) : () => {}), () => broker?.getVersion() ?? 0);
  useVersioned((fn) => (status ? status.subscribe(fn) : () => {}), () => status?.getVersion() ?? 0);
  useEffect(() => (cache ? cache.subscribeAll(force) : undefined), [cache]);

  const events = useMemo(() => {
    const all = [...hub.events()].reverse(); // newest first
    const q = filter.trim().toLowerCase();
    return q ? all.filter((e) => e.type.toLowerCase().includes(q)) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hub.getVersion() invalidates via useVersioned
  }, [hub, filter, hub.getVersion()]);

  if (!open) {
    return (
      <button style={toggle} onClick={() => setOpen(true)} aria-label="Open agent-query devtools">
        ⚡ {title}
      </button>
    );
  }

  const pending = broker?.list() ?? [];
  const now = Date.now();

  return (
    <div style={panel} data-testid="agent-query-devtools">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ color: "#e5c07b" }}>⚡ {title} devtools</strong>
        <button style={{ ...toggle, position: "static" }} onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>

      {status && (
        <section>
          <div style={h}>peers</div>
          {status.list().map(([peer, s]) => (
            <span
              key={peer}
              data-testid={`peer-${peer}`}
              style={{
                display: "inline-block",
                margin: "0 6px 4px 0",
                padding: "1px 8px",
                borderRadius: 10,
                background: "#282c34",
                border: `1px solid ${STATE_COLORS[s.state]}`,
                color: STATE_COLORS[s.state],
              }}
            >
              {peer} · {s.state}
              {s.attempt > 0 ? ` ×${s.attempt}` : ""}
            </span>
          ))}
        </section>
      )}

      {cache && (
        <section>
          <div style={h}>cache ({cache.entriesForDevtools().length})</div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ color: "#5c6370" }}>
                {["key", "status", "stale", "opt", "subs", "age"].map((c) => (
                  <th key={c} style={cell}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cache.entriesForDevtools().map((e) => (
                <tr key={e.key} data-testid={`cache-row-${e.key}`}>
                  <td style={{ ...cell, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{e.key}</td>
                  <td style={cell}>{e.status}</td>
                  <td style={cell}>{e.isStale ? "yes" : "no"}</td>
                  <td style={{ ...cell, color: e.isOptimistic ? "#e5c07b" : undefined }}>
                    {e.isOptimistic ? "yes" : "no"}
                  </td>
                  <td style={cell}>{e.subscribers}</td>
                  <td style={cell}>{e.updatedAt ? `${Math.max(0, Math.round((now - e.updatedAt) / 1000))}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {broker && (
        <section>
          <div style={h}>pending interactions ({pending.length})</div>
          {pending.map((i) => (
            <div key={i.id} data-testid={`interaction-${i.id}`}>
              #{i.id} {i.type} · {i.peer}
              {i.manual ? " · manual" : ""}
            </div>
          ))}
        </section>
      )}

      <section>
        <div style={h}>events ({events.length})</div>
        <input
          aria-label="Filter events by type"
          placeholder="filter by type…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "#282c34",
            color: "#abb2bf",
            border: "1px solid #3a3f4b",
            borderRadius: 4,
            padding: "2px 6px",
            font: "inherit",
            marginBottom: 4,
          }}
        />
        {events.map((e, idx) => (
          <div key={idx} data-testid="event-row" style={{ borderBottom: "1px solid #282c34", padding: "1px 0" }}>
            <span style={{ color: "#c678dd" }}>{e.type}</span>{" "}
            <span style={{ color: "#5c6370" }}>{summarize(e)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function summarize(e: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k !== "type"));
  try {
    const s = JSON.stringify(rest);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return "[unserializable]";
  }
}
