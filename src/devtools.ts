// Devtools event protocol — adapters emit serializable events; a panel (in-app, or
// piped to a browser extension over postMessage / a WebSocket) renders them. The
// event vocabulary is adapter-defined; the core supplies the base shape, the sink
// interface, and a ring-buffer hub with fan-out.

export interface DevtoolsEventBase {
  type: string;
  [k: string]: unknown;
}

export interface DevtoolsSink<TEvent extends DevtoolsEventBase = DevtoolsEventBase> {
  emit(e: TEvent): void;
}

/** A ring-buffer sink that also fans out to subscribers — what a panel reads. */
export class DevtoolsHub<TEvent extends DevtoolsEventBase = DevtoolsEventBase> implements DevtoolsSink<TEvent> {
  private buf: TEvent[] = [];
  private subs = new Set<() => void>();
  private version = 0;
  constructor(private capacity = 500) {}

  emit(e: TEvent): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.shift();
    this.version++;
    for (const fn of this.subs) fn();
  }
  /** Monotonic counter bumped on every emit — lets panels use useVersioned/useSyncExternalStore. */
  getVersion(): number {
    return this.version;
  }
  events(): readonly TEvent[] {
    return this.buf;
  }
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  /** The buffer as versioned, JSON-safe data (see {@link DEVTOOLS_SCHEMA_VERSION}). Does not mutate the buffer. */
  snapshot(): DevtoolsSnapshot<TEvent> {
    return { version: DEVTOOLS_SCHEMA_VERSION, events: this.buf.map((e) => toSerializableEvent(e) as TEvent) };
  }
}

// ---------------------------------------------------------------------------
// Serialization schema (versioned). A panel in another realm (a browser
// extension, a worker, a protocol inspector) receives `DevtoolsSnapshot` JSON.
// Bump DEVTOOLS_SCHEMA_VERSION on any breaking change to the shapes below.
// ---------------------------------------------------------------------------

/** Integer schema version of {@link DevtoolsSnapshot} and {@link WireSummary}. */
export const DEVTOOLS_SCHEMA_VERSION = 1;

/** The JSON-safe form of a hub's buffer. `version` is {@link DEVTOOLS_SCHEMA_VERSION}. */
export interface DevtoolsSnapshot<TEvent extends DevtoolsEventBase = DevtoolsEventBase> {
  version: number;
  events: TEvent[];
}

/**
 * Deep-copy `value` into JSON-safe data: bigint -> decimal string, Error ->
 * `{name,message}`, Date -> ISO string, Map -> entries array, Set -> values array,
 * functions/symbols/undefined dropped, cycles -> `"[Circular]"`.
 */
export function toSerializableEvent<T>(value: T): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    switch (typeof v) {
      case "bigint":
        return v.toString();
      case "function":
      case "symbol":
      case "undefined":
        return undefined;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "object":
        break;
      default:
        return v;
    }
    if (v === null) return null;
    const o = v as object;
    if (seen.has(o)) return "[Circular]";
    if (o instanceof Date) return Number.isNaN(o.getTime()) ? null : o.toISOString();
    seen.add(o);
    let out: unknown;
    if (o instanceof Error) {
      out = { name: o.name, message: o.message };
    } else if (o instanceof Map) {
      out = [...o.entries()].map(([k, val]) => [walk(k), walk(val)]);
    } else if (o instanceof Set) {
      out = [...o.values()].map(walk);
    } else if (Array.isArray(o)) {
      out = o.map((x) => walk(x) ?? null);
    } else {
      const rec: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        const w = walk(val);
        if (w !== undefined) rec[k] = w;
      }
      out = rec;
    }
    seen.delete(o); // only true ancestors count as cycles; shared refs are fine
    return out;
  };
  return walk(value);
}

/**
 * Parse and validate a JSON {@link DevtoolsSnapshot}. Throws on malformed input or
 * a `version` this build does not understand (anything other than the current one).
 */
export function parseDevtoolsSnapshot(json: string): DevtoolsSnapshot {
  const raw = JSON.parse(json) as { version?: unknown; events?: unknown };
  if (typeof raw !== "object" || raw === null || typeof raw.version !== "number") {
    throw new Error("devtools snapshot: missing numeric version");
  }
  if (raw.version !== DEVTOOLS_SCHEMA_VERSION) {
    throw new Error(`devtools snapshot: unsupported version ${raw.version} (this build reads ${DEVTOOLS_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(raw.events)) throw new Error("devtools snapshot: events must be an array");
  for (const e of raw.events) {
    if (typeof e !== "object" || e === null || typeof (e as { type?: unknown }).type !== "string") {
      throw new Error("devtools snapshot: every event needs a string type");
    }
  }
  return raw as DevtoolsSnapshot;
}

/** A bodyless one-line summary of a wire message: no params, result or error text. */
export interface WireSummary extends DevtoolsEventBase {
  type: "wire";
  dir: "in" | "out";
  kind: "request" | "notification" | "response" | "error";
  method?: string;
  id?: string | number;
  /** Numeric `error.code` when the peer sent one. */
  errorCode?: number;
}

/** Reduce a {@link TrafficEvent} to a {@link WireSummary} (safe to ship to an inspector). */
export function summarizeTraffic(e: { dir: "in" | "out"; message: { method?: string; id?: string | number; error?: unknown } }): WireSummary {
  const m = e.message ?? {};
  const out: WireSummary = {
    type: "wire",
    dir: e.dir,
    kind: m.error !== undefined ? "error" : m.method !== undefined ? (m.id !== undefined ? "request" : "notification") : "response",
  };
  if (m.method !== undefined) out.method = m.method;
  if (m.id !== undefined) out.id = m.id;
  const code = (m.error as { code?: unknown } | undefined)?.code;
  if (typeof code === "number") out.errorCode = code;
  return out;
}
