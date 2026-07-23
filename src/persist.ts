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
  const raw = storage.getItem(key);
  if (raw) {
    try {
      cache.hydrate(JSON.parse(raw));
    } catch {
      /* ignore corrupt snapshot */
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = cache.subscribeAll(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => storage.setItem(key, JSON.stringify(cache.dehydrate())), opts.debounce ?? 250);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
