// Cache persistence — hydrate from storage on start, then debounce-save on change.
// Works with any synchronous key/value store (localStorage, sessionStorage, a memory
// shim for SSR/tests). For an embeddable web app this is the offline/restore story.

import type { QueryCache } from "./cache.js";

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PersistOptions {
  key?: string;
  /** Debounce window for writes (ms). Default 250. */
  debounce?: number;
}

/** Hydrate `cache` from `storage` and keep it saved. Returns a stop() function. */
export function persistCache(cache: QueryCache<never> | QueryCache<any>, storage: SyncStorage, opts: PersistOptions = {}): () => void {
  const key = opts.key ?? "agent-query-cache";
  try {
    const raw = storage.getItem(key);
    if (raw) cache.hydrate(JSON.parse(raw));
  } catch {
    /* ignore corrupt snapshot / unreadable storage */
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = cache.subscribeAll(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        storage.setItem(key, JSON.stringify(cache.dehydrate()));
      } catch {
        /* storage full / unavailable — persistence is best-effort, never crash the app */
      }
    }, opts.debounce ?? 250);
    // Don't hold the (Node) process open for a pending save; no-op in browsers.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    unsub();
  };
}
