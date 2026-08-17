# `tools scripts`

Call MCP tools from a plain TypeScript script instead of through an agent loop, with typed
bindings generated from each server's live `tools/list`. Every MCP server already configured
on this machine (any provider mcp-manager reads: Claude global and per-project, Gemini,
Cursor, Codex) is reachable — no agent loop, no tool definitions in context, no waiting for
a model turn between calls.

```bash
tools scripts servers                       # what exists, and how it connects
tools scripts tools 'genesis-tools.*'       # live tools/list, cached after first probe
tools scripts call genesis-tools.handoff_list '{"limit":5}'
```

## When this beats calling an MCP tool directly

Direct tool calls are correct for one or two calls. Switch to a script when any of these is
true:

- The same tool runs more than about three times. Each direct call is a full model turn; the
  script is one.
- Results need looping, diffing, filtering or asserting before a human sees them.
- The server is not loaded in the current agent session. The script does not care what the
  session loaded at startup.
- The output is large and only a slice matters. Filter inside the script.
- The sequence needs to be repeatable later. Persisted scripts survive the session.

## Selector grammar

`tools`, `describe`, `call` and `create --import` take selectors of the form
`[provider:]<server>.<tool>`. Either half of the pair may contain `*`:

| Selector | Means |
|---|---|
| `chrome-devtools-mcp.*` | every tool on that server |
| `chrome-devtools-mcp` | same, shorthand |
| `*.take_screenshot` | that tool wherever it exists |
| `genesis-tools.handoff_*` | prefix match on the tool name |
| `mcp:genesis-tools.handoff_*` | same, provider spelled out |
| `*.*` | everything, which probes every server and is slow the first time |

The provider prefix is reserved grammar for future binding surfaces (`openapi:`,
`composio:`, `graphql:`, `gt:`). **A bare selector means `mcp:` forever**, so the short form
never breaks. v1 implements only the mcp provider.

Add `--schema` to `tools` for full input schemas, `--grep` to search names and
descriptions, `--json` for machine output, `--refresh` to re-probe.

## Persisted scripts

`create` writes a runnable scaffold with typed bindings for exactly the tools you name.

```bash
tools scripts create colTriage \
  --import 'chrome-devtools-mcp.*' 'genesis-tools.handoff_*' \
  --description 'Reproduce the bug, then file a handoff' \
  --tag triage --tag col
```

Scripts live in a global store at `~/.genesis-tools/scripts/`, one directory per script:

- `persisted/colTriage/colTriage.ts` is yours. Edit it freely.
- `persisted/colTriage/colTriage.tools.ts` is generated: one function per matched tool,
  argument types derived from the server's live `inputSchema`, description carried over as
  JSDoc. Never hand-edit it; `regen` rewrites it.
- Anything else the script needs — a preset, a state file, a progress log, an `out/`
  directory — belongs in that same folder.

The two-file split exists so regenerating bindings after a server changes its schema cannot
touch your code. `create` without `--import` scaffolds a bindings-free script that still has
the kit (use `kit.callRef`).

```bash
tools scripts run colTriage -- --flag value   # runs it, records the run; script args after --
tools scripts list                            # scripts visible from here
tools scripts show colTriage                  # metadata plus source
tools scripts regen colTriage                 # re-probe, rewrite bindings, report added/removed
tools scripts rename colTriage triage         # folder, files, sidecars, imports, journal
tools scripts rm colTriage                    # moves to trash/, prints the restore command
tools scripts doctor                          # verify the store; read-only, prints fixes
```

### Versioning (the store is a git repo)

The store is initialised as a plain **local** git repository on first scaffold, with
`node_modules/`, `cache/`, `trash/` and per-script `out*/` ignored. Every mutating verb
(`create`, `regen`, `rename`, `tag`, `rm`) auto-commits its change (staging an explicit
allowlist, never the credential cache), so script history is always one
`tools scripts git -- log --oneline` away; `run` does not commit (run-counter churn is
swept by the next mutation).

No remote exists until you decide. The decision is persisted in the store's
`config.json`, and `create` prints a one-line offer until you make it:

```bash
tools scripts remote <url>                # add/update origin, push -u, remember the decision
tools scripts remote --none               # "no remote wanted" — stops the offer
tools scripts remote --auto-push on       # push after every store commit (off by default)
tools scripts remote                      # show origin + auto-push state
tools scripts git -- log --oneline        # any git command against the store
```

### Gating (project-scoped visibility)

`create --gated` marks a script as belonging to the current project (the enclosing git
repo). Outside that directory tree it disappears from `list` (`--all` reveals it), but
`run <name>` works from anywhere — metadata never gates execution. Toggle later with
`tag <name> --gate` / `--ungate`. Everything else (`--project`, `--tag`, `--cwd`,
`--server`, `--grep`) is a descriptive filter, never a restriction.

## How a persisted script resolves its imports

The store carries a generated `tsconfig.json` mapping `@gt/scripts/*` to this checkout's
`src/scripts/lib/`. Bun resolves the nearest tsconfig upward from the entry file, so plain
`bun persisted/x/x.ts` works and scripts read cleanly:

```typescript
import { data, must, text, withKit } from "@gt/scripts/kit";
import * as T from "./colTriage.tools.ts";

await withKit(async (kit) => {
    const pages = must(await T.chromeDevtoolsMcp_listPages(kit), "list_pages");
    console.log(text(pages));

    // Independent calls run concurrently over the open session.
    const [snapshot, console_] = await kit.all([
        () => T.chromeDevtoolsMcp_takeSnapshot(kit),
        () => T.chromeDevtoolsMcp_listConsoleMessages(kit),
    ]);

    // Anything not bound at create time is still reachable.
    const raw = await kit.callRef("genesis-tools.handoff_list", { limit: 3 });
    console.log(data<{ handoffs: unknown[] }>(raw)?.handoffs.length);
}, { servers: ["chrome-devtools-mcp", "genesis-tools"] });
```

If the repo moves, the next `create`/`run` rewrites the mapping; `doctor` reports a stale
one. npm deps a script imports directly (`commander`, `picocolors`, plus anything you
`bun add` there) come from the store's own `package.json` — `run` installs them when
missing. `mcporter` resolves from the repo because only kit code imports it.

Binding names are the tool name in camelCase; when an import spans more than one server
they are prefixed with the server (`chromeDevtoolsMcp_listPages`). The generated file's
`TOOLS` export lists them all.

### Result helpers

MCP results are an envelope, not the value you want. From `@gt/scripts/kit`:

| Helper | Gives you |
|---|---|
| `text(raw)` | the concatenated text blocks, the usual case |
| `data<T>(raw)` | `structuredContent` when the server declared an `outputSchema`, else the text parsed as JSON, else `undefined` |
| `images(raw)` | base64 image blocks, e.g. from a screenshot tool |
| `isError(raw)` | whether the server flagged the call as failed |
| `must(raw, label)` | the value, or a throw carrying the server's error text |
| `result(raw)` | mcporter's full `CallResult` when you want `.markdown()` or `.content()` |

`withKit` always closes the runtime, including on a throw. Use it rather than `createKit`
so stdio servers do not leak processes.

## Recipes

**Fan out one tool over many inputs** — the single biggest win; thirty calls cost one model
turn:

```typescript
const results = await kit.all(
    QUERIES.map((q) => async () => ({
        query: q,
        hits: text(must(await T.searchGitHub(kit, { query: q }), q)).split("\n").length,
    }))
);
```

**Poll until a condition holds** — a loop belongs in a script, never in an agent turn:

```typescript
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
    const state = data<{ status: string }>(await T.getStatus(kit, { id }));
    if (state?.status === "done") return;
    await Bun.sleep(5_000);
}
throw new Error("timed out");
```

**Filter a huge result before anything sees it**:

```typescript
const all = data<{ requests: Request[] }>(await T.listNetworkRequests(kit))?.requests ?? [];
const failed = all.filter((r) => r.status >= 400);
console.log(`${failed.length} failed of ${all.length}`);
```

**Chain two servers** — read from one, write to the other, real logic in between (this is
why multi-server imports exist). **Diff two runs** — capture, change something, capture
again, compare; impossible to express as direct tool calls.

## Token efficiency

A script that hands raw tool output to a model pays for that output every time it is
mentioned. Two library halves address it, both importable from any script:

- `@gt/scripts/refs` — print a large value in full exactly once, preview it thereafter
  (`formatValueWithRef`, `loadRefStore`, `saveRefStore`, `truncateList`, `parseRef`). Ids
  are derivable (`n5.cont` = node 5, context field), never random.
- `@gt/scripts/schema` — shape instead of data: `formatSchema(payload)` renders
  `{ id: number, items: [{ title: string, note?: string }] }` for the cost of one line
  (`"skeleton"` | `"typescript"` | `"schema"` modes), and `describeCollection(items)` gives
  a one-line census. Array items are unioned, not sampled, so a field present in one of 900
  elements still shows up. On a real 900-element array: 12,632 chars of JSON versus 57 of
  skeleton.

Rules the ref system encodes, worth applying even without it: print a large value in full
exactly once; make ids derivable; one mandatory load verb that indexes and caches; never
drop silently (`truncateList` says `… +N more`); one escape hatch named `--full`
everywhere; end output with a `Tip:` naming the exact next command.

## Credentials

Remote MCP servers are OAuth-protected, and a script has no browser.
`src/scripts/lib/claude-tokens.ts` reads the tokens Claude Code already obtained (keychain
payload, `mcpOAuth` key) and attaches them as Bearer headers. Worth knowing:

- **A missing token does not look like a missing token.** The streamable POST 401s,
  mcporter falls back to legacy SSE, and that GET returns 405. The visible error is
  `SSE error: Non-200 status code (405)`. The kit therefore reports missing/expired tokens
  up front on stderr.
- **Expired tokens are reported, not refreshed.** Refresh tokens rotate; spending Claude
  Code's copy would break the server inside the app. Re-authorise with `/mcp`.
- **Reusing the app's token also dodges client whitelisting** (Figma 403s unapproved OAuth
  clients). Do not register a new client to "do it properly" — that is the path that fails.

## Facts worth knowing before designing a script

- **There is no batching.** JSON-RPC batching was removed from MCP in the 2025-06-18 spec
  revision. `kit.all()` fires concurrent requests over one open session — the only lever.
- **The first probe of a stdio server is slow** (process spawn + initialize handshake).
  Cached afterwards; `--refresh` busts it. A failed server is cached as an error so one
  broken entry does not re-block later runs.
- **Servers that need arguments you do not have fail at the schema, not at runtime.** Read
  `describe '<server>.<tool>'` before writing calls.
- **A server disabled everywhere is not listed.** `servers --all` shows those too; enable
  via `tools mcp-manager enable`.

## Cache and state

| Path | What |
|---|---|
| `~/.genesis-tools/scripts/cache/registry.json` | last provider scan, busted by `--refresh` |
| `~/.genesis-tools/scripts/cache/tools.json` | per-server `tools/list`, busted by `--refresh` |
| `~/.genesis-tools/scripts/persisted/_journal.json` | script metadata, tags, gating, run history |
| `~/.genesis-tools/scripts/persisted/<name>/` | one script, its bindings, its sidecars |
| `~/.genesis-tools/scripts/trash/` | where `rm` moves things; nothing is deleted outright |
| `~/.genesis-tools/scripts/tsconfig.json` | generated `@gt/scripts/*` alias into this checkout |
