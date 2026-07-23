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
  constructor(private capacity = 500) {}

  emit(e: TEvent): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.shift();
    for (const fn of this.subs) fn();
  }
  events(): readonly TEvent[] {
    return this.buf;
  }
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
