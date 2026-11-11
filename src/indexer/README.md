# tools indexer

`tools indexer` chunks a codebase along syntax boundaries instead of at fixed line counts, embeds the chunks,
and searches them by keyword and by meaning, so a hit comes back as a whole function and not as the middle
nine lines of one. It also serves the same indexes to an AI assistant over MCP.

## Quick start

```bash
tools indexer models                                  # list embedding models, grouped by provider
tools indexer add ~/Projects/app --model darwinkit    # index a repo with the free on-device macOS model
tools indexer search "how are refresh tokens rotated" # search the index of the current directory
tools indexer sync                                    # pick up changes in every index since the last run
tools indexer watch app                               # keep one index current while you edit
tools indexer status                                  # one table row per index
```

In a terminal, `add` with no path starts a wizard that asks for the path, name, type and model, and `add`
with a path but no `--model` shows a model picker first.

## Commands

`tools indexer -v <command>` turns on verbose logging. `tools indexer --readme` prints this page.

### Build and maintain an index

- `add [path]`: create an index for a directory, then run the first full sync. The name defaults to the
  folder name.
  - `--name <name>`: index name (default: the directory basename).
  - `--type <type>`: `code`, `files`, `mail` or `chat`. Auto-detect picks `code` when the folder has a
    `package.json` or a `.git`, and `files` otherwise.
  - `--chunking <mode>`: `ast`, `line` or `auto` (default `auto`). The chunker also accepts `heading`,
    `message`, `json` and `character`.
  - `--model <id>`: embedding model id from `tools indexer models`. The provider follows from the id.
  - `--no-embed`: fulltext only, no embeddings.
  - `--ignore <patterns>`: comma-separated extra ignore patterns. Each one is a plain substring of the
    relative path, not a glob.
  - `--include <suffixes>`: comma-separated file suffixes to keep, with or without the dot (`ts,tsx`).
  - `--watch`: keep running and watch the folder after the first sync.
  - `--storage <driver>`: `sqlite`, `orama` or `turbopuffer`. The value is saved, but no code reads it
    today: every index is SQLite.
- `sync [name-or-path]`: incremental sync. It hashes every file, re-chunks new and changed files, and drops
  deleted ones. Without an argument it syncs every index. A path matches an index by its folder basename
  only.
- `watch [name]`: run a sync, then watch the folder and sync on each change. Without a name it watches every
  index. Ctrl+C stops it.
- `rebuild [name]`: full reindex. It re-reads every source file and re-chunks it. In a terminal it asks first.
  Without a name it asks which index in a terminal, and exits 1 without one. It does not drop the chunks of
  files deleted since the last sync: run `sync` afterwards.
- `stop <name>`: ask a running sync of that index, in another process, to stop at its next checkpoint.
- `remove [name]`: delete an index and all its data. Without a name it opens a multiselect.
  - `--force`: skip the confirmation. Required when stdin or stdout is not a terminal.

### Search and inspect

- `search <query>`: search one or more indexes.
  - `-i, --index <name>`: the index to search, or `all`. Default: the index whose folder holds the current
    directory (the deepest one wins), or the only index there is. Otherwise it asks in a terminal. Without
    a terminal it prints `Multiple indexes found. Use -i <name> or -i all.` and exits 0. A folder with a
    `.genesistoolscontext.json` also gets a `<name>__context` index with the same folder (see
    [Context indexes](#context-indexes)), so neither default finds one index there: pass `-i <name>`.
  - `-m, --mode <mode>`: `fulltext`, `vector` or `hybrid` (`semantic` means `vector`). Default: `hybrid`
    when any searched index has embeddings, otherwise `fulltext`.
  - `-l, --limit <n>`: maximum results (default 20).
  - `-f, --file <filter>`: keep only results whose file path contains this substring.
  - `--format <type>`: `pretty`, `simple`, `table`, `json` or `toon`. Default: `pretty` in a terminal,
    `simple` when piped.
  - `-c, --confidence <min>`: drop results under this confidence, 0 to 100.
- `status [name]`: without a name, one table row per index (files, chunks, embedded share, status, last
  sync, database size). With a name: base folder, chunking, git-ignore use, embedding dimensions, search
  count and average search time.
- `verify [name]`: check each index (or one) for consistency: the SQLite integrity check, path hashes
  against content rows, orphan embeddings and chunks with no embedding.
- `graph <name>`: the import graph of a code index.
  - `--format <format>`: `stats` (default), `mermaid`, `circular` or `json`.
  - `--max-nodes <n>`: nodes in the Mermaid diagram (default 30).
  - `--file <path>`: what one file imports and what imports it. The path matches exactly or as a suffix.

### Embedding models

- `models`: list the embedding models, grouped by provider, with their ids, dimensions, context length and
  install command. Local HuggingFace models show whether they are downloaded.
  - `--type <type>`: `code`, `files`, `mail` or `chat`. Best matches for that index type come first.
  - `--flat`: one table instead of groups.
- `models download <model-id>`: download a local HuggingFace model ahead of time, so the first index does
  not wait for it.

### Context artifacts

A context artifact is a file or folder that explains a project (a schema, an API spec) and that you want
searchable beside the code. They are listed in `.genesistoolscontext.json` in the index's base folder.

- `context list [index-name]`: list the artifacts of each index and their state: `indexed`, `new` or
  `missing`.
- `context add <index-name>`: add an artifact to `.genesistoolscontext.json`.
  - `--name <name>`, `--path <path>` (relative to the index base folder) and `--description <desc>`: all
    three are required.
  - `--sync`: sync the context index afterwards.
- `context remove <index-name>`: remove an artifact. `--name <name>` is required, `--sync` as above.
- `context sync [index-name]`: re-index the context artifacts of one index, or of all.

### Vector storage and benchmarks

- `migrate-vec [name]`: move an index's vectors from the brute-force blob table to a sqlite-vec table.
  Without a name it asks which index in a terminal, and exits 1 without one.
  - `--dry-run`: print the plan and write nothing.
- `benchmark [dir]`: index a folder into a throwaway index, run fixed search queries, print the phase times
  and throughput as JSON, then delete the index.
  - `-o, --output <path>`: also save the JSON to a file.
  - `-p, --provider <provider>`, `-m, --model <model>`: the embedder to measure.
  - `--no-embed`: fulltext-only benchmark.
  - `--compare-providers`: embed generated sample texts with every available provider and recommend the
    fastest. No folder needed.
  - `--compare-models`: the same across the models of one provider (`-p`, default `ollama`).
  - `--duration <seconds>`: seconds per provider in comparison mode (default 30).
  - `--sample-count <n>`: sample texts to generate (default 500).
  - `--sample-type <type>`: `mail` (default), `code` or `general`.
- `bench-vectors`: compare vector search backends on random vectors in a temporary database. It does not
  read your indexes; to measure your own folder, use `benchmark <dir>`.
  - `--vectors <n>` (default 10000), `--dimensions <n>` (default 768), `--queries <n>` (default 100),
    `--limit <n>` results per query (default 10).
  - `--backends <list>`: comma-separated (default `sqlite-vec,sqlite-brute`).

### MCP server

- `mcp-serve`: start the indexer MCP server on stdio, for an AI assistant. See [For agents](#for-agents).

## How it works

### Where data lives

```text
~/.genesis-tools/indexer/
  config.json              every index's settings, keyed by name
  <name>/index.db          one SQLite database per index (WAL mode)
  <name>/index.lock        held by the process that has the index open
  <name>/stop.signal       written by `stop`, removed when a sync reads it
  benchmarks/              compare-<timestamp>.json from `benchmark --compare-providers`
```

`GENESIS_TOOLS_HOME` moves the whole tree: the root becomes `$GENESIS_TOOLS_HOME/.genesis-tools/`.

Each `index.db` holds the chunks with an FTS5 table, the embeddings, a hash per file path, a log of searches
(behind the counts in `status`), and a cached import graph. The schema is migrated on every read-write
open.

### The pipeline

1. **Scan.** A `code` index uses `git ls-files --cached --others --exclude-standard` inside a git repo, so it
   follows `.gitignore`. Any other folder is walked, skipping folders that start with a dot and
   `node_modules`. Then `--include`, `--ignore` and a `.genesistoolsignore` file in the base folder
   (gitignore syntax) filter the list.
2. **Detect changes.** Each file's content hash is compared with the stored hash for that path, so `sync`
   touches only what changed. `rebuild` treats every file as new, so it does not see deleted files: their
   chunks stay until the next `sync` removes them.
3. **Chunk.** `auto` picks per file: `heading` for Markdown, `json` for `.json` and `.jsonl`, `ast` for the
   languages below, `message` for mail and chat indexes, and `line` for the rest.
   - AST chunks follow declarations. A declaration over 150 lines is split, and pieces under 5 lines are
     merged.
   - Chunks hold about 500 tokens for code and files (`chunkMaxTokens`). For mail and chat, the limit is
     the embedding model's context length (8192 when unknown), so one message is one chunk, up to 2,000
     characters. A longer message becomes several chunks.
   - A file whose average line is over 500 characters counts as minified and is cut by characters. No chunk
     is longer than 2,000 characters.
4. **Embed.** Chunks without an embedding are embedded in batches per provider: ollama 500, cloud 2048,
   google 100, darwinkit 100, coreml 100, local-hf 32 (from benchmarks on 2026-04-08). The size follows the
   `embedding.provider` that `config.json` names, so `openai`, and every index made without `--model`, use
   32. Progress is saved per page, so an interrupted run loses little.
5. **Store and search.** Fulltext uses SQLite FTS5 with BM25. Vectors live in a sqlite-vec table when the
   extension loads, and in a brute-force blob table when it does not. Hybrid search merges both lists with
   reciprocal rank fusion.

AST chunking covers TypeScript, JavaScript, HTML and CSS through the built-in grammars, plus Python, Go,
Rust, Java, C, C++, Ruby, PHP, Swift, Kotlin, Scala and C# through `@ast-grep/lang-*` packages. Those are
declared in `package.json`. If one is missing from `node_modules`, the indexer installs it with bun: in a
terminal it asks first, without a terminal it installs directly. The import graph reads the same languages
except HTML and CSS, and it resolves TypeScript path aliases from `tsconfig.json`.

### Interrupted runs

A sync marks the index `in-progress` and clears the mark when it finishes. A run killed by Ctrl+C or a crash
keeps the mark. The next `sync` or `watch` first resumes every index marked `in-progress` or `cancelled`,
then does what you asked. `status <name>` tells you when an index was interrupted.

### One process per index

Opening an index for writing takes `<name>/index.lock`. The lock expires 2 minutes after its owner dies.
`search`, `sync`, `watch`, `graph`, `verify` and the MCP server all open indexes this way. While `watch`,
`mcp-serve` or a long `sync` holds an index, another command on the same index fails with
`Index "<name>" is locked by another process`.

### Search modes and confidence

- `fulltext`: BM25 keyword match. The confidence is the score relative to the best BM25 hit of the query.
- `vector`: cosine similarity of the query embedding, times 100.
- `hybrid`: both lists fused by rank. The confidence is the fused score against the highest possible fused
  score.

Use `-c` to cut weak hits. A confidence of 60 in `hybrid` and a confidence of 60 in `fulltext` do not mean
the same thing.

### Embedding providers

`tools indexer models` lists every model. The providers:

- `darwinkit`: macOS NaturalLanguage.framework, on device and free (512 dimensions). The model id is
  `darwinkit`.
- `coreml`: on device, Neural Engine.
- `ollama`: local models through Ollama (for example `nomic-embed-text`). `add` checks that Ollama runs and
  offers to pull a missing model.
- `local-hf`: HuggingFace models through ONNX, for example `Xenova/all-MiniLM-L6-v2` (384 dimensions, about
  25 MB). Models are cached in `~/.cache/huggingface/hub` or the transformers.js cache.
- `cloud`: OpenAI `text-embedding-3-small` (1536 dimensions). Needs `OPENAI_API_KEY`.
- `openai`: OpenAI `text-embedding-3-large` (3072 dimensions). Needs `OPENAI_API_KEY`.
- `google`: `gemini-embedding-001` (3072 dimensions). Needs `GOOGLE_API_KEY` or
  `GOOGLE_GENERATIVE_AI_API_KEY`.

Without `--model`, the embedder comes from the `embed` task of the AI config (`tools ai`), whose default is
`darwinkit`. If that provider is not available, the first available one of ollama, coreml, darwinkit,
local-hf, cloud and google is used. `openai` is not in that fallback list: pick it with
`--model text-embedding-3-large`.

### What it needs and what costs money

- Bun's built-in SQLite on macOS cannot load extensions. The indexer swaps in Homebrew's SQLite
  (`brew install sqlite`) before it opens a database. Without it, vectors go to the slower brute-force
  table, and an index that already has a sqlite-vec table refuses to open.
- A `mail` index reads Mail.app's Envelope Index under `~/Library/Mail/`, not the path you pass. That needs
  Full Disk Access for the app that runs `tools`.
- `cloud` and `openai` embeddings are paid per token, and `google` beyond its rate-limited free tier. A
  `rebuild` or a first sync of a large folder with a cloud model can cost real money.
  `benchmark --compare-providers` also runs a paid provider for the full `--duration` when its key is set.
  Every other provider runs on the Mac.

### `rebuild` versus `migrate-vec`

These sound similar and do different things.

**`rebuild`** re-reads the source files and re-chunks them. Use it after changing chunking behaviour, or
when an index has drifted from reality in a way `sync` cannot repair. It does **not** change the vector
driver.

**`migrate-vec`** changes the storage backend. It moves vectors from the brute-force blob table to a
sqlite-vec table for faster nearest-neighbour search, then drops the old table. It does not re-read your
source. In a terminal it asks before it writes; without a terminal it does not ask. Run `--dry-run` first.

`sync` is the everyday command: incremental, cheap, and enough for normal editing. `watch` runs it for you.

### Verify before you trust

`verify` checks consistency and reports problems. Run it after an interrupted index, a crash, or a
`migrate-vec`. An index that silently lost chunks returns confident, incomplete search results, which is
worse than an obvious failure. `verify` reports problems as warnings and still exits 0.

### Context indexes

When `add` finds a `.genesistoolscontext.json` with artifacts in the base folder, it also creates a companion
index named `<name>__context`. A folder artifact is read as one document: every readable file in it,
sorted by path, under a `# -- <file> --` header. `remove` deletes the companion with its parent and hides
it from its picker. The companion has the same base folder as its parent, so `search` without `-i` no longer
finds one index for that folder. `tools ask` reads the same file to add the artifacts to its prompt. A later
process cannot re-sync the companion (see [Troubleshooting](#troubleshooting)), so refresh it by removing
the index and adding it again.

## Configuration

### `~/.genesis-tools/indexer/config.json`

`add` writes one entry per index. There is no command to change an entry, so edit the file to change one of
the keys below. `sync`, `watch`, `rebuild`, `verify`, `graph` and the search itself read the file each time
they open an index, so an edit reaches them. `status`, the MCP `indexer_status` tool, the folder match of
`search`, and `context list`, `context add` and `context remove` read the copy of the entry that `index.db`
saved at `add` time. They keep showing and using the old values.

```json
{
  "indexes": {
    "app": {
      "name": "app",
      "baseDir": "/absolute/path/to/app",
      "type": "code",
      "respectGitIgnore": true,
      "chunking": "auto",
      "includedSuffixes": ["ts", "tsx"],
      "ignoredPaths": ["generated/"],
      "embedding": { "enabled": true, "provider": "darwinkit", "model": "darwinkit" },
      "watch": { "strategy": "native", "debounceMs": 2000, "autoStart": true }
    }
  }
}
```

- `type`: `code`, `files`, `mail` or `chat`.
- `respectGitIgnore`: list files through git. `add` sets it to `true` for `code` indexes.
- `chunking`: `auto`, `ast`, `line`, `heading`, `message`, `json` or `character`.
- `chunkMaxTokens`: chunk size for code and files (default 500). Mail and chat ignore it.
- `includedSuffixes`, `ignoredPaths`: the `--include` and `--ignore` lists.
- `embedding.enabled` (default `true`), `embedding.provider`, `embedding.model`.
- `storage.vectorDriver`: unset means sqlite-vec with a brute-force fallback. `sqlite-brute` forces the
  blob table. `qdrant` stores vectors in Qdrant and needs `storage.qdrant.url` (`apiKey` and
  `collectionName` are optional).
- `search.minScore`: drop results under this raw score (default 0).
- `watch.strategy`: `polling` syncs every `watch.interval` milliseconds (default 300000, 5 minutes). Any
  other value uses the native file watcher, which waits `watch.debounceMs` (default 2000) after the last
  change.
- `watch.enabled`: set by `add --watch`, and shown by `status` as it was at `add` time.
- `watch.autoStart`: `sync` starts the watcher for this index after it syncs, and keeps running.

### Files in the indexed folder

- `.genesistoolsignore`: gitignore syntax. It applies to every index of that folder, git or not.
- `.genesistoolscontext.json`: the context artifacts. Each one needs a `name`, a `path` (relative to the
  folder, or absolute) and a `description`. Names must be unique, ignoring case.

```json
{
  "artifacts": [
    { "name": "database-schema", "path": "db/schema.sql", "description": "Tables and indexes" },
    { "name": "api-spec", "path": "docs/api", "description": "The public HTTP API" }
  ]
}
```

### Environment

- `GENESIS_TOOLS_HOME`: moves the data root (see [Where data lives](#where-data-lives)).
- `OPENAI_API_KEY`: needed for the `cloud` and `openai` providers.
- `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`: needed for the `google` provider. Without one of them,
  `google` counts as not available.
- `GOOGLE_RATE_LIMIT_MS`: the pause in milliseconds between two `google` batch calls. Unset means no pause.
  A negative value sets 12 seconds, which fits the free tier's 5 requests per minute.
- `HF_HOME`: where the HuggingFace hub cache lives, for `local-hf` models.

## For agents

### CLI output

- `search --format json` prints an array of `{ index, file, name, language, confidence, method, lines,
  preview }`. `lines` is `"<start>-<end>"` or `null`, and `preview` holds the first 200 characters of the
  chunk on one line. `--format toon` prints the same rows in TOON, with fewer tokens.
- Status lines go to stdout too, so pass `-i <name>` together with `--format json`. When the index comes
  from the current directory, a `(using index "<name>" from cwd)` line comes before the JSON. With no hits,
  the output is the line `No results found.`, not `[]`.
- `graph <name> --format json` prints the whole graph (nodes and edges), after a `Using cached graph` or
  `Building code graph...` line. `benchmark <dir>` prints its result JSON after its summary lines. Read the
  JSON from the first `{` or `[`.
- When piped, `search` defaults to `simple`, and `remove` needs a name and `--force`. `add` needs a path,
  `rebuild` and `migrate-vec` need a name. Pass `--model` to `add`, or it picks the embedder from the AI
  config.
- Always pass `-i <name>` to `search`. Without it, a folder with a context companion index matches two
  indexes, and without a terminal `search` prints `Multiple indexes found.` and exits 0 with no results.

### Exit codes

- 0: success. These cases also exit 0, after an error or a warning:
  - `verify` with warnings.
  - `search` with no hits, with an invalid `--format`, `--mode` or `--confidence`, or with several indexes,
    no folder match and no terminal (`Multiple indexes found.`).
  - `migrate-vec` with no `config.json` (`No indexes configured.`), an unknown index (`database not found`),
    or a sqlite-vec load failure (`Failed to load sqlite-vec extension`).
  - `context list` and `context sync` with an unknown index: they only warn.
  - `stop` with any name. It does not check the name, so an unknown one creates
    `~/.genesis-tools/indexer/<name>/stop.signal`.
- 1: in most other commands, an unknown or locked index. Also an embedding setup error, a missing argument
  without a terminal, an `add` path that does not exist, a `context add` or `context remove` error, a
  `watch` that could start nothing, `models --type` with an unknown type, `models download` with an unknown
  model or one that is not `local-hf`, `benchmark` with no folder and no comparison flag, and
  `benchmark --compare-providers` with no provider available.
- 130: Ctrl+C.

### MCP server

`tools indexer mcp-serve` speaks MCP over stdio, so an assistant can query the index instead of grepping.
That is the main reason to run it: semantic retrieval over a large codebase, without the assistant reading
files to find out where things are. A client configuration:

```json
{ "mcpServers": { "indexer": { "command": "tools", "args": ["indexer", "mcp-serve"] } } }
```

Use the absolute path of `tools` if the client does not start with your shell's `PATH`. The server keeps
each index it touched open, and holds its lock, until it exits.

Tools:

- `indexer_search`: `query`, optional `indexName` (default: all), `limit` (1 to 100, default 20), `mode`,
  `minScore` (0 to 1), `fileFilter`.
- `indexer_index`: `path` (absolute), optional `name`, `provider` (`darwinkit`, `local-hf`, `cloud`,
  `ollama`), `model`, `noEmbed`. It always creates a `code` index that follows `.gitignore`, and returns when
  the first sync is done.
- `indexer_sync`: `name`.
- `indexer_status`: optional `name`.
- `indexer_remove`: `name`. It deletes the index without asking.
- `indexer_stop`: `name`. It cancels only a sync that runs inside the server itself.
- `indexer_graph_build`, `indexer_graph_stats`: `name`.
- `indexer_graph_query`: `name`, `file` (relative to the index base folder).
- `indexer_graph_visualize`: `name`, optional `maxNodes` (5 to 200, default 30). It returns Mermaid.
- `indexer_models`: optional `type`.

There is no plugin skill for this tool.

## Troubleshooting

- **`Index "<name>" is locked by another process`.** Another process has the index open: `watch`,
  `mcp-serve` or a sync in another terminal. Stop that process, or wait 2 minutes if it died. `sync` can
  fail this way for an index you did not name, because it first resumes every index marked in progress,
  and that index may really be running elsewhere.
- **Vector search is slow.** sqlite-vec probably failed to load, and vectors went to the brute-force table.
  That failure has historically appeared only in the log file, so check `~/.genesis-tools/logs/<today>.log`
  for `sqlite-vec`. Install Homebrew SQLite (`brew install sqlite`), then run `migrate-vec <name>`.
- **`sqlite-vec is required to read this index`.** The index has a sqlite-vec table, and this process found
  no Homebrew SQLite at `/opt/homebrew/opt/sqlite3/lib/` or `/usr/local/opt/sqlite3/lib/`. Run
  `brew install sqlite`. The message also suggests `--vector-driver sqlite-brute`, which is not a flag: the
  setting is `storage.vectorDriver` in `config.json`.
- **`Embedding setup failed`.** The chosen provider is not available: Ollama is not running
  (`ollama serve`), a model is not pulled, or a cloud key is missing. The message prints the recommended
  models. Every command that opens an index with embeddings builds the embedder first, so `search` (even
  with `-m fulltext`), `sync`, `watch`, `verify`, `graph` and `rebuild` fail this way too.
  - On an existing index: start the provider (`ollama serve`, `ollama pull <model>`) or set its key, then
    run the command again. Do not remove the index: its data is fine.
  - After a failed `add`: the entry stays in `config.json`, and a second `add` answers
    `Index "<name>" already exists`. Run `tools indexer remove <name> --force`, then add again with
    `--model <id>` or `--no-embed`. When the message suggests `add --provider`, use `--model`: `add` has no
    `--provider` flag.
- **`search` asks which index, or prints `Multiple indexes found`, inside an indexed folder.** The folder has
  a `.genesistoolscontext.json`, so `add` also made a `<name>__context` index with the same folder, and the
  folder match finds two. Pass `-i <name>`.
- **`add` printed `Embeddings: disabled (no model selected)`, but the index has embeddings.** Without a
  terminal and without `--model`, embeddings stay on and the embedder comes from the AI config. Pass
  `--no-embed` to turn them off.
- **The wizard made an index with embeddings after you picked `No embeddings (fulltext-only)`.** In the
  `add` wizard, that entry in the model list still leaves embeddings on. Answer No to
  `Enable semantic embeddings?` instead.
- **`stop` did nothing.** `stop` only drops `stop.signal` in the index folder. A sync reads it in the
  embedding phase, after every fifth page of at least 1,000 chunks. A run that ends earlier leaves the file
  behind, and the next long embedding run of that index stops at its fifth page. To stop a foreground run,
  press Ctrl+C. The next `sync` resumes it.
- **`verify` says `Run --rebuild to fix`.** It means `tools indexer rebuild <name>`.
- **Context artifacts do not reach the index, or `sync` exits 1 at `<name>__context`.** Only `add` creates
  and syncs the `<name>__context` index, from the `.genesistoolscontext.json` that exists at that moment.
  `context sync` says the index "will be created when you next sync the parent index", but `sync` never
  creates it. Later syncs of the companion fail as well: `config.json` stores its source as plain data
  (`{ "projectPath": … }`), and nothing turns that back into a source. So `sync` with no name exits 1 when it
  reaches the companion, and `watch` prints `Failed to start watch` for it. To refresh the artifacts, remove
  the index and add it again. Sync the other indexes by name.
- **The first index of a Python, Go or Rust folder stops at a prompt, or runs `bun add`.** The AST grammar
  for that language is missing from `node_modules`. Run `bun install` in the GenesisTools checkout to get
  every grammar, then try again.

## Related

- [`tools ts`](../ts/README.md): `tools ts skeleton --max-tokens <n>` gives a cheap structural map, ranked
  by importers, with no embedding step. Use it when you need shape rather than semantics.
- [`tools macos`](../macos/README.md): `tools macos mail index` builds the `macos-mail` index in this tool's
  storage, with date filters, and `tools macos mail search` searches it.
- [`tools ask`](../ask/README.md): reads `.genesistoolscontext.json` and adds its artifacts to the prompt.
- [`tools ai`](../ai/README.md): the AI config whose `embed` task picks the default embedder.
- [docs/ai.md](../../docs/ai.md): the embedding providers, batch sizes and chunk sizing in more depth.
- [docs/fts5_vs_orama_search_demo.html](docs/fts5_vs_orama_search_demo.html): an interactive page that
  compares SQLite FTS5 and Orama keyword search side by side.
