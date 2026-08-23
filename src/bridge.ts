// The tag/key -> TanStack-style queryKey translation contract for bridge
// packages (e.g. @johnhenry/mcp-query-tanstack, @johnhenry/a2a-query-tanstack)
// consuming QueryCache's `onExternalInvalidate`. Pure string/array utilities,
// no @tanstack/query-core dependency — every bridge package imports these
// from core instead of inventing its own convention, so a tag invalidation
// means the same queryKey shape everywhere.

import type { Tag } from "./cache.js";

/** Fixed root segment every agent-query-derived queryKey starts with. */
export const QUERY_KEY_NAMESPACE = "agent-query" as const;

/**
 * Tag -> queryKey segments: tags are `:`-delimited hierarchical paths (see
 * `entityTag`), e.g. "tool:server.name" -> ["agent-query", "tool", "server.name"].
 * This is a PREFIX, not a full key — TanStack's default invalidateQueries does
 * prefix matching, so a bridge's queryOptions() factory should nest its own
 * queryKey under this same prefix (appending call-specific args after it) for
 * a push invalidation on this tag to actually match.
 */
export function tagToQueryKey(tag: Tag): unknown[] {
  return [QUERY_KEY_NAMESPACE, ...tag.split(":")];
}

/**
 * Structured cache-key -> queryKey, for invalidateKeys() pass-through:
 * namespaced under a fixed "key" segment (distinct from the tag namespace
 * above) with the adapter's own canonical serialized form as the leaf.
 */
export function keyToQueryKey<K>(serializeKey: (key: K) => string, key: K): unknown[] {
  return [QUERY_KEY_NAMESPACE, "key", serializeKey(key)];
}
