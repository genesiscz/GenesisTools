# Caches that never show older data

Contents: 1. the rule · 2. file identity · 3. `FileIdentityCache` · 4. time-derived fields · 5. the session rows
cache and the daemon · 6. the hub server · 7. incremental scans of append-only files · 8. what was rejected.

## 1. The rule

The user's requirement (2026-10-12): no change may ever show staler, less live or older content; more live is the
goal. A cache is acceptable only when it can skip work for input that provably did not change, and the proof is
taken fresh on every use. Ask of every cache: "what input could change without this cache noticing?" If the
answer is not "none", the cache is wrong, however rare the case.

## 2. File identity

- A file's identity is its inode, size, mtime and ctime (`fileIdentity(path)` in `src/utils/fs/identity-cache.ts`).
  Any write moves the ctime, and a replaced file gets a new inode, so a rewrite that keeps size and mtime still
  shows. The mtime alone is not enough.
- Take the identity BEFORE reading the file. A write during the read then leaves a newer identity than the one
  stored, and the next use reads the file again. Taking it after the read can pin old content to a new identity.
- A `stat` costs about 2.5 µs; re-reading identities on every call is cheap. Never replace it with "the folder did
  not change" (APFS does not update a folder's mtime on an append) or with a time-to-live.

## 3. `FileIdentityCache` (`src/utils/fs/identity-cache.ts`)

```ts
const cache = new FileIdentityCache<Header>({
    limit: 10_000,
    persist: { path: () => toolDataDir("x", "cache", "headers.json"), version: 1, isValue: isHeader },
});
await cache.load();                       // once per process; merges a saved file under in-memory entries
const identity = await fileIdentity(path);
const hit = cache.get(path, identity);    // only when the identity matches exactly
if (!hit) { const value = read(path); if (identity) cache.set(path, identity, value); }
await cache.save();                       // temporary file + rename, only when something changed
```

- Bump `version` whenever the meaning of a cached value changes (a parser change, a new field). A file of another
  version is ignored, never half-trusted. `isValue` checks every saved entry; one that fails is dropped.
- Do not cache failures (a missing header, a read error): read again and report again next time.
- **The limit must exceed what one pass touches.** A cache smaller than one pass evicts each entry just before the
  pass needs it and never hits: the tail cache held 2,000 entries for 2,404 transcripts and missed every one on every
  full listing (1,832 ms against 911 ms once the limit was 20,000). The cache is least-recently-used, and evicting an
  entry the same process used logs a warning (`[identity-cache] evicted an entry this process used`), so a limit
  that has become too small shows in the day log instead of silently costing a second.
- `fileIdentity` is a synchronous `statSync`: the async `stat` cost about 4 times the CPU (cold Codex discovery
  40 → 27 ms, warm 27 → 14 ms).
- Users: Codex rollout headers (`codex-discovery.ts`, persisted), Claude tail usage (`session-rows.ts`, persisted).
  The Grok summary cache (`grok-discovery.ts`) is the same idea in memory with a string identity.
- Effect: a fresh process re-reads only changed files. The usage daemon's row build went from 1,180 to 423 ms of
  CPU; Claude tail usage of 627 transcripts costs about 390 ms uncached and a `stat` per file cached.
- Tests run with a sandboxed `GENESIS_TOOLS_HOME` (bunfig preload), so a persisted cache never touches real data.

## 4. Time-derived fields

A cached answer must not freeze a value that depends on the clock. The session list's `cacheStatus` and
`cacheTtlSec` are computed when the answer is SERVED, from `lastCacheAt` and `cacheLifetimeSec` (facts of the
transcript): `withLiveCacheClocks` in `src/ai/lib/sessions/rows-cache.ts`, `computeCacheStatus` in
`src/claude/lib/usage/cache-clock.ts` (a small module, so the cheap cached path does not load the listing code).
Before, those fields were as old as the cached rows, up to 90 s.

## 5. The session rows cache and the daemon

- `~/.genesis-tools/ai/usage-sessions.json` holds one query and its rows; it is served for 90 s
  (`SESSION_ROWS_MAX_AGE_MS`), and the daemon refreshes it every minute while someone asked within the hour.
- The daemon tick (`src/ai/commands/usage/poll-daemon.ts`) does two jobs: account usage over HTTP (must stay: the
  providers keep no history of the % windows) and, as a passenger, the session rows rebuild.
- The rebuild re-reads everything every tick and re-parses only changed files. It does not skip.

## 6. The hub server

`tools hub serve` (TypeScript, unix socket `~/.genesis-tools/hub/server/hub.sock`, `src/hub/server/`) answers 13
doors from warm memory. Every caller works without it. Started by the GenesisTools.app hub window, and by the
daemon's tick when a health probe finds nothing listening (`ensureHubServer`, at most once per 5 minutes; a busy
server is left alone). It exits after 10 minutes without a connection, above 512 MB, or when its source changes.

## 7. Incremental scans of append-only files

A cache that counts what was appended since the last read (the Codex agents' tool-call scan,
`src/hub/lib/agents/codex-agents.ts`) assumes the file only grows. "The file is at least as large as before" is not
proof of that: a file replaced by a larger one passes. Keep the inode beside the size and offset, and start over when
it differs (the old code kept the old file's count for a replaced rollout; fixed with a test that fails on it). An
in-place rewrite that keeps the inode and grows is still not caught; if that can happen, also keep a few bytes
before the offset and compare them.

## 8. Rejected

- **Skip the daemon's rebuild when no session file changed.** The rows also depend on the pin journal, cmux
  references, Grok account files, the history index and the clock; a skip check that missed one would serve old
  rows until another file changed. The identity cache gets most of the saving exactly.
- **A time-to-live on file-derived data.** Always older by up to the TTL.
- **Caching an mtime and not stat'ing.** The `stat` is the check.
