# tools indexer

> **Semantic code indexer with AST-aware chunking and hybrid search.**

Chunks a codebase along syntax boundaries rather than at fixed line counts, embeds the chunks, and searches with both vectors and keywords. The point is that a hit comes back as a whole function, not as the middle nine lines of one.

---

## Commands

| Command | Description |
|---------|-------------|
| `add [path]` | Add and index a directory |
| `search <query>` | Search across indexes |
| `status [name]` | Show index status |
| `sync [name-or-path]` | Incremental sync: re-scan for changes |
| `watch [name]` | Watch indexes for changes |
| `rebuild [name]` | Full reindex: re-scan sources and re-chunk |
| `migrate-vec [name]` | Migrate vector storage from brute-force blobs to sqlite-vec |
| `remove [name]` | Remove one or more indexes and their data |
| `verify [name]` | Check index consistency and report problems |
| `stop <name>` | Stop an in-progress index operation |
| `models` | List available embedding models |
| `graph <name>` | Show the code dependency graph for an index |
| `context` | Manage context artifacts (`.genesistoolscontext.json`) |
| `benchmark [dir]` | Benchmark indexing and search performance |
| `bench-vectors` | Micro-benchmark: compare vector search backends |
| `mcp-serve` | Start the indexer MCP server over stdio |

## Quick start

```bash
tools indexer models                    # what embedding models are available
tools indexer add .                     # index this repo
tools indexer status
tools indexer search "how are refresh tokens rotated"
tools indexer sync                      # pick up changes since the last run
tools indexer watch                     # keep it current automatically
tools indexer graph myrepo
tools indexer verify
tools indexer mcp-serve                 # expose search to an AI assistant
```

---

## `rebuild` versus `migrate-vec`

These sound similar and do different things.

**`rebuild`** re-reads the source files and re-chunks them. Use it after changing chunking behaviour, or when an index has drifted from reality in a way `sync` cannot repair. It does **not** change the vector driver.

**`migrate-vec`** changes the storage backend, moving vectors from brute-force blobs to sqlite-vec for faster nearest-neighbour search. It does not re-read your source.

`sync` is the everyday command: incremental, cheap, and enough for normal editing. `watch` runs it for you.

## Verify before you trust

`verify` checks consistency and reports problems. Worth running after an interrupted index, a crash, or a `migrate-vec`. An index that silently lost chunks returns confident, incomplete search results, which is worse than an obvious failure.

## The MCP server

`mcp-serve` exposes search over stdio, so an assistant can query the index instead of grepping. That is the highest-value use of this tool: semantic retrieval over a large codebase, without the assistant reading files to find out where things are.

## Notes

- Vector search performance depends on the backend. `bench-vectors` compares sqlite-vec against brute force on your actual data, which is the only comparison that matters.
- ⚠️ If sqlite-vec fails to load, search falls back to slower behaviour. That failure has historically appeared only in the log file, so check `~/.genesis-tools/logs/<today>.log` when search feels unexpectedly slow.
- Related: [`tools repo-map`](../repo-map/README.md) gives a cheap structural map with no embedding step. Use it when you need shape rather than semantics.
