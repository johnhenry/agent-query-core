// Transport instrumentation — taps every message in both directions so a devtools
// panel can show a full wire log. Wraps any transport-shaped object transparently
// via a Proxy (structural typing — no protocol SDK dependency), so it survives
// SDK changes and works across protocols.

export interface TransportLike {
  onmessage?: (message: unknown, extra?: unknown) => void;
  send(message: unknown, options?: unknown): Promise<void> | void;
  [k: string]: unknown;
}

export type TrafficDirection = "out" | "in";

export interface TrafficEvent {
  dir: TrafficDirection;
  /** A wire message (for JSON-RPC: request / response / notification). */
  message: { method?: string; id?: string | number; params?: unknown; result?: unknown; error?: unknown };
}

export function instrumentTransport<T extends TransportLike>(inner: T, onTraffic: (e: TrafficEvent) => void): T {
  let handler: ((m: unknown, extra?: unknown) => void) | undefined;
  // Tap incoming once; everything the consumer sets goes through `handler`.
  // Forward the second arg (auth/classification info) — dropping it breaks SDKs
  // that classify inbound traffic at the edge.
  inner.onmessage = (m, extra) => {
    onTraffic({ dir: "in", message: m as TrafficEvent["message"] });
    handler?.(m, extra);
  };

  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "onmessage") return handler;
      if (prop === "send") {
        return (message: unknown, options?: unknown) => {
          onTraffic({ dir: "out", message: message as TrafficEvent["message"] });
          return (target.send as (m: unknown, o?: unknown) => Promise<void>)(message, options);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(target, prop, value) {
      if (prop === "onmessage") {
        handler = value as typeof handler;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
  }) as T;
}
