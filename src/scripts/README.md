# tools scripts

Call MCP tools from a plain TypeScript script instead of through an agent loop. The tool reads every MCP server
already configured on this machine (through mcp-manager), probes its live `tools/list`, generates typed bindings, and
keeps the result as a versioned Bun script you can run again. There is no model turn between calls and no tool
definition in anybody's context.

## Quick start

```bash
tools scripts servers                                       # what exists, and how it connects
tools scripts tools 'genesis-tools.*'                       # live tools/list, cached after the first probe
tools scripts describe 'genesis-tools.handoff_list'         # every parameter before you write a call
tools scripts call genesis-tools.handoff_list '{"limit":5}' # one call, text result on stdout
tools scripts create bugTriage --import 'genesis-tools.handoff_*'   # a persisted script with typed bindings
tools scripts run bugTriage                                 # run it; the run is recorded
```

Quote every selector that contains `*`, or the shell expands it.

## When a script beats a direct tool call

A direct tool call is correct for one or two calls. Use a script when any of these is true:

- The same tool runs more than about three times. Each direct call is a full model turn; the script is one.
- Results need looping, diffing, filtering or asserting before a human sees them. A tool call cannot express control
  flow.
- The server is not loaded in the current agent session. The script does not care what the session loaded at startup.
- The output is large and only a slice matters. Filter inside the script, so the model never sees the rest.
- The sequence must be repeatable later. Persisted scripts survive the session.

## Commands

`--readme` prints this page, and `-v, --verbose` adds debug output. Both work with any command.

### Discover servers and tools

```bash
tools scripts servers [--all] [--refresh] [--json]
tools scripts tools [selectors...] [--names] [--grep <text>] [--schema] [--refresh] [--json]
tools scripts describe <ref> [--refresh] [--json]
```

- `servers` lists every enabled MCP server mcp-manager finds, with its state, its transport (`stdio`, `http`, `sse`)
  and its command or URL. `--all` adds servers that are disabled everywhere. `--refresh` scans the editor configs
  again. `servers` only reads: it never writes the cache and never mints a gateway token.
- `tools` lists the tools that match the selectors, one signature per tool (`name(req: string, opt?: number)`) with
  the first line of its description. With no selector it uses `*.*`, which probes every enabled server.
  - `--names`: names only.
  - `--grep <text>`: keep tools whose name or description contains the text (case-insensitive).
  - `--schema`: add the full input schema (verbose; the signature is usually enough).
  - `--refresh`: probe the servers again instead of reading the tool cache.
- `describe` prints every parameter of a tool with its type, the required flag and its description. It also says
  whether the tool returns structured content (it declares an `outputSchema`) or text blocks. A pattern prints every
  match.

### Call one tool

```bash
tools scripts call <server>.<tool> ['<json object>'] [--args-file <path|->] [--timeout <ms>] [--json]

echo '{"limit": 5}' | tools scripts call genesis-tools.handoff_list --args-file -
```

- The arguments must be a JSON object. Comments and trailing commas are accepted.
- `--args-file <path>` reads the object from a file; `-` reads stdin.
- `--timeout <ms>`: the per-call timeout. Default `120000` (two minutes, because browser and search tools are slow).
- `--json` prints the raw MCP result envelope instead of the text blocks.
- The ref must name exactly one tool. A `*` is refused.

### Persisted scripts

```bash
tools scripts create <name> [options]       # scaffold persisted/<name>/ with bindings
tools scripts list [filters]                # scripts visible from here
tools scripts show <name> [--json]          # metadata plus source
tools scripts run <name> [-- <args...>]     # run it with bun; script flags go after --
tools scripts regen <name> [--force]        # probe again, rewrite <name>.tools.ts only
tools scripts rename <from> <to>            # folder, files, sidecars, imports, journal
tools scripts tag <name> [options]          # tags, project label, visibility gate
tools scripts rm <name>                     # move to trash/, print the restore command
```

`create <name>`:

- `-i, --import <selectors...>`: the tools to bind, for example `'chrome-devtools-mcp.*' '*.handoff_*'`. Without
  `--import`, the script has no bindings but still has the kit (use `kit.callRef`).
- `-d, --description <text>`: what the script is for.
- `-t, --tag <tags...>`: tags for filtering later. Repeat the flag or give several values.
- `-p, --project <name>`: the project label. Default: the folder name of the enclosing git repo, else of the current
  directory.
- `--gated`: hide the script from `list` outside the current project tree (see Gating below).
- `--refresh`: probe the servers again before binding.
- `--force`: replace a script of the same name. The old `<name>.ts` and `<name>.tools.ts` are copied to `trash/`
  first. Sidecars stay where they are. It also replaces the journal entry, so pass `--description`, `--tag`,
  `--project` and `--gated` again. The run history starts at 0. To refresh bindings only, use `regen`.
- `--dry-run`: print which functions would bind to which tools, and write nothing (not even the caches).

A name starts with a letter and holds only letters, digits, `-` and `_`. `--import` and `--tag` take several values,
so put the name first: `create bugTriage --import 'a.*' 'b.*'`. A name after `--import` is read as one more selector.
`create` prints the script's directory as its last line on stdout.

`list` filters (all of them only describe; none of them blocks a run):

- `--tag <tags...>`: scripts that carry all of these tags.
- `--project <name>`: scripts with this project label.
- `--cwd [path]`: scripts created at or below this directory. The bare flag means the current directory.
- `--server <name>`: scripts bound to this server.
- `--grep <text>`: a substring of the name, description, tags or tool refs.
- `--all`: include scripts gated to other projects. A gated script shows a `⌂` mark.

`run <name>` runs `bun install` in the store when `node_modules` has no `commander`, heals the import alias, then runs
`bun <name>.ts` in your current directory with your stdin, stdout and stderr. It records the time, the directory, the
exit code and the duration in the journal, and exits with the script's own exit code. Pass the script's flags after
`--`: `tools scripts run bugTriage -- --limit 3`.

`regen <name>` scans the editor configs again, probes every server the script's selectors reach (not only the bound
ones), and rewrites `<name>.tools.ts`; your `<name>.ts` is not touched. It prints the added (`+`) and removed (`-`)
bindings, because callers of a removed binding will now fail. It refuses when a server the script was bound to did
not respond, so a short outage cannot strip its bindings. `--force` accepts the loss. When nothing matches any more,
it fails and leaves the bindings as they are. A script created without `--import` has nothing to regenerate.

`rename <from> <to>` moves the folder. Every file whose name starts with `<from>.` gets the new stem
(`<from>.state.json` becomes `<to>.state.json`); subfolders move whole. It rewrites the `./<from>.tools.ts` import and
`scripts run <from>` hints in the folder's `.ts` files, and updates the journal. It refuses when `<to>` exists.

`tag <name>` options: `--add <tags...>`, `--remove <tags...>`, `--project <name>`, and `--gate` or `--ungate` (not
both). `--gate` gates the script to the git repo that encloses the current directory (or to the directory itself
outside a repo).

`rm <name>` moves the whole folder to `trash/<timestamp>-<name>/`, drops the journal entry, and prints an `mv` command
that puts the folder back. Nothing is deleted outright. When the folder is already gone, it only drops the stale
entry.

### Store history

The store is a local git repository (see How it works).

```bash
tools scripts git -- log --oneline           # any git command, run inside the store
tools scripts remote                         # show origin and the auto-push state
tools scripts remote git@example.com:alice/scripts.git   # add or update origin, push main, remember it
tools scripts remote --none                  # no remote wanted; the create-time offer stops
tools scripts remote --auto-push on          # push after every store commit (off by default)
```

- `git [args...]` runs `git -C <store>` with your terminal and exits with git's exit code. Pass git flags after `--`.
- `remote <url>` sets `origin`, then runs `git push -u origin main`. A failed first push prints a warning and the retry
  command; the decision is saved either way. `--auto-push <on|off>` works with or without a url. `--none` and a url
  together are refused.

### Health

```bash
tools scripts doctor [--json]
```

`doctor` checks the store and prints a fix for each finding. It is read-only: it applies no fix, fills no cache and
mints no token. It checks:

- the `@gt/scripts/*` alias in the store's `tsconfig.json` (missing, another checkout, or a dead path);
- the store's `node_modules`;
- whether the store is a git repo, and how many changes are not committed yet;
- whether `persisted/_journal.json` parses;
- the mode of `cache/registry.json` (it must be `600`, because it holds API keys);
- journal entries whose file is missing, whose servers no provider lists any more, or whose gate directory is gone;
- probe failures that sit in the tool cache;
- the MCP OAuth tokens Claude Code holds, and which of them expired;
- when a server signs in through the mcp-manager gateway: the gateway's health, and a live token in the GenesisTools
  vault for each such server.

## Selectors

`tools`, `describe`, `call` and `create --import` take selectors of the form `[provider:]<server>.<tool>`. Either half
of the pair may contain `*`.

| Selector                      | Means                                       |
|-------------------------------|---------------------------------------------|
| `chrome-devtools-mcp.*`       | every tool on that server                   |
| `chrome-devtools-mcp`         | the same, shorthand                         |
| `*.take_screenshot`           | that tool on every server that has it       |
| `genesis-tools.handoff_*`     | prefix match on the tool name               |
| `mcp:genesis-tools.handoff_*` | the same, provider spelled out              |
| `*.*`                         | everything; probes every server, slow first |

- Matching is case-insensitive for `tools`, `describe` and `create --import`. `call` and `kit.callRef` need the
  server name in its exact case.
- The server half is matched against the known server names first (exact case), longest name first. So a server
  whose name holds a `.` or a `:` still parses.
- The provider prefix is reserved for future binding surfaces (`openapi:`, `composio:`, `graphql:`, `gt:`). **A bare
  selector means `mcp:` forever**, so the short form never breaks. Only `mcp` exists today; another prefix is an error
  that names the known set.
- A selector probes only the servers it can reach: one stdio server, not all thirty.

## Writing a persisted script

`create` writes two files into `~/.genesis-tools/scripts/persisted/<name>/`:

- `<name>.ts` is yours. Edit it freely. It is executable and starts with `#!/usr/bin/env bun`.
- `<name>.tools.ts` is generated: one function per matched tool, argument types derived from the server's live
  `inputSchema`, the description carried over as JSDoc. Never edit it by hand; `regen` rewrites it.
- Anything else the script needs (a preset, a state file, a progress log, an `out/` folder) belongs in the same folder.

The two-file split exists so that regenerating bindings after a server changes its schema cannot touch your code. The
starter body calls a tool that needs no arguments, so a new script runs at once. When every bound tool needs
arguments, the starter shows the expected argument type in a comment instead.

A script bound to two servers, after you edit it. Create it first:

```bash
tools scripts create pageTriage \
  --import 'chrome-devtools-mcp.*' 'genesis-tools.handoff_*' \
  --description 'Reproduce the bug, then file a handoff' \
  --tag triage
```

```typescript
import { data, must, text, withKit } from "@gt/scripts/kit";
import * as T from "./pageTriage.tools.ts";

await withKit(async (kit) => {
    const pages = must(await T.chromeDevtoolsMcp_listPages(kit), "list_pages");
    console.log(text(pages));

    // Independent calls run concurrently over the open session.
    const [snapshot, consoleLog] = await kit.all([
        () => T.chromeDevtoolsMcp_takeSnapshot(kit),
        () => T.chromeDevtoolsMcp_listConsoleMessages(kit),
    ]);

    // kit.callRef reaches any tool on these servers by its ref, bound or not.
    const raw = await kit.callRef("genesis-tools.handoff_list", { limit: 3 });
    console.log(data<{ handoffs: unknown[] }>(raw)?.handoffs.length);
}, { servers: ["chrome-devtools-mcp", "genesis-tools"] });
```

### Imports

The store has a generated `tsconfig.json` with three aliases into this GenesisTools checkout:

- `@gt/scripts/*` maps to `src/scripts/lib/` (the kit, refs and schema helpers).
- `@gt/chrome-devtools/*` maps to `src/chrome-devtools/lib/` (used by `tools chrome-devtools scaffold` scripts).
- `@gt/utils/*` maps to `src/utils/`.

Bun resolves the nearest `tsconfig.json` upward from the entry file, so a plain `bun persisted/x/x.ts` works too. If
the checkout moves, the next `create`, `run`, `regen`, `remote <url>` or `git` rewrites the mapping; `doctor` reports a
stale one.

npm packages a script imports directly come from the store's own `package.json`: `commander`, `picocolors`,
`pixelmatch` and `pngjs` ship by default, plus anything you `bun add` in the store. `run` runs `bun install` in the
store when `node_modules` has no `commander`; a direct `bun <file>` does not. After you edit `package.json` by hand,
run `bun install` in the store yourself. `mcporter` resolves from the GenesisTools checkout, because only kit code
imports it.

### Bindings

- A binding is the tool name in camelCase. When an import spans more than one server, the server name is the prefix
  (`chromeDevtoolsMcp_listPages`).
- A name that is a reserved word gets a `Tool` suffix (`deleteTool`). A name that is taken gets a number (`list2`).
- Each binding is `fn(kit, args)` with a typed `<Fn>Args` object, or `fn(kit)` for a tool without parameters.
- The module also exports `SERVERS` (the bound servers) and `TOOLS` (every binding by name).
- A required argument is required in the type, so a type-check catches a missing one before the server does. Read
  `describe '<server>.<tool>'` before you write a call.

### The kit

`withKit(fn, options)` opens the runtime, runs `fn(kit)`, and always closes it, also on a throw. Use it rather than
`createKit`, so stdio servers do not leak processes.

The `kit` object:

- `kit.call(server, tool, args)` calls one tool. A transport failure throws; an MCP error result comes back as data.
- `kit.callRef("<server>.<tool>", args)` is the same with one string. It refuses a pattern. It reaches only the
  servers the kit opened (`kit.servers()`), and throws `Unknown server in ref` for any other. To reach another
  server, add it to the `servers` option first.
- `kit.all([() => ..., () => ...])` runs calls concurrently over the open session.
- `kit.listTools(server)`, `kit.servers()`, `kit.close()`.

Options for `withKit` and `createKit`:

- `servers`: restrict the runtime to these servers. Default: every enabled server. The scaffold passes the bound ones.
- `timeoutMs`: the per-call timeout. Default 120000.
- `refresh`: scan the provider configs again instead of reading the registry cache.
- `persist`: write the registry cache and mint the gateway token. `withKit` turns it on; `createKit` leaves it off.
- `disableOAuth`: never start an interactive OAuth flow. Default `true`, because a script has no browser.

### Result helpers

An MCP result is an envelope, not the value you want. From `@gt/scripts/kit`:

- `text(raw)`: the text blocks joined. This is the usual case.
- `data<T>(raw)`: `structuredContent`, else the text parsed as JSON, else `undefined`.
- `images(raw)`: the base64 image blocks, for example from a screenshot tool.
- `isError(raw)`: whether the server flagged the call as failed.
- `must(raw, lbl)`: the result unchanged, or a throw with the first 500 characters of the error.
- `result(raw)`: mcporter's full `CallResult`, for `.markdown()` or `.content()`.

A server sets `structuredContent` when it declared an `outputSchema`; `describe` tells you which kind a tool returns.

### Recipes

**Fan out one tool over many inputs.** This is the biggest win: thirty calls cost one model turn.

```typescript
const results = await kit.all(
    QUERIES.map((q) => async () => ({
        query: q,
        hits: text(must(await T.searchGitHub(kit, { query: q }), q)).split("\n").length,
    }))
);
```

**Poll until a condition holds.** A loop belongs in a script, never in an agent turn.

```typescript
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
    const state = data<{ status: string }>(await T.getStatus(kit, { id }));
    if (state?.status === "done") return;
    await Bun.sleep(5_000);
}
throw new Error("timed out");
```

**Filter a huge result before anything sees it.**

```typescript
const all = data<{ requests: Request[] }>(await T.listNetworkRequests(kit))?.requests ?? [];
const failed = all.filter((r) => r.status >= 400);
console.log(`${failed.length} failed of ${all.length}`);
```

**Chain two servers.** Read from one, write to the other, with real logic in between. This is why one script can bind
several servers. **Diff two runs.** Capture, change something, capture again, compare. Direct tool calls cannot
express either.

### Token efficiency

A script that hands raw tool output to a model pays for that output every time it is mentioned. Two helper modules
address it, and any script can import them:

- `@gt/scripts/refs` prints a large value in full exactly once and only a preview after that (`formatValueWithRef`,
  `loadRefStore`, `saveRefStore`, `truncateList`, `parseRef`). A value of 1200 characters or less prints inline; a
  larger one prints in full the first time with a `[ref:<id>]` tag, then as the tag, a 240-character preview and its
  size. Ids are derivable, never random (`n5.cont` means node 5, context field).
- `@gt/scripts/schema` gives shape instead of data. `formatSchema(payload)` renders
  `{ id: number, items: [{ title: string, note?: string }] }` for the cost of one line, in `"skeleton"`,
  `"typescript"` or `"schema"` mode. `describeCollection(items)` gives a one-line census. Array items are unioned, not
  sampled, so a field present in one of 900 elements still shows up. On a real 900-element array: 12,632 characters of
  JSON against 57 of skeleton.

Rules the ref system encodes, worth applying even without it: print a large value in full exactly once; make ids
derivable; have one mandatory load verb that indexes and caches; never drop silently (`truncateList` says
`… +N more`); name the one escape hatch `--full` everywhere; end the output with a `Tip:` that names the exact next
command.

### Gating (project-scoped visibility)

`create --gated` marks a script as belonging to the current project: the git repo that encloses the current
directory, or the directory itself outside a repo. Outside that tree the script disappears from `list` (`--all`
shows it), but `run <name>` works from anywhere: metadata never gates execution. Toggle it later with
`tag <name> --gate` or `--ungate`. Every other filter (`--project`, `--tag`, `--cwd`, `--server`, `--grep`) only
describes and never restricts.

## How it works

### Where the servers come from

The tool imports mcp-manager's provider scan in-process. It covers Claude Code (global and per project), Gemini,
Codex, Cursor and Grok, with one resolved enabled state per server. The definitions go to mcporter's runtime, which
handles the transport and the connections; mcporter never reads a config file of its own here. A stdio server starts
in the current directory, with its configured `env` merged over yours.

A selector probes only the servers it can reach, four at a time. The first probe of a stdio server is slow (process
spawn and `initialize` handshake); after that the result comes from the cache. A server that fails is cached as an
error, so one broken entry does not block every later run.

**Neither cache expires.** After you add, enable or change a server in an editor config, pass `--refresh` once to
`tools`, `describe` or `create`, or run `regen`. `servers --refresh` scans again but does not write the cache. A
server disabled everywhere is not listed: `servers --all` shows it, and `tools mcp-manager enable` turns it on.

The registry cache carries each server's `env` and `headers`, which often hold API keys. Both cache files are written
atomically with mode `600`. A registry cache with a looser mode is tightened by the next `tools`, `describe`, `call`,
`create`, `regen` or script run. A registry cache from before 2026-09-14 (schema 1) is treated as a miss, because
gateway servers changed shape then.

### Credentials

Remote MCP servers are usually OAuth-protected, and a script has no browser. There are two paths:

- **Gateway servers.** A server that mcp-manager signs in through its local OAuth gateway is dialled at the gateway's
  loopback address with the local gateway token. The gateway holds the real tokens in the GenesisTools vault. When a
  script needs such a server and the gateway does not answer, the kit starts it: through its launchd agent when that
  is installed, otherwise inside the script's process (it does not keep the script alive). Sign in with
  `tools mcp-manager auth login <server>`.
- **Other remote servers** get a Bearer header from the tokens Claude Code already obtained: on macOS the keychain
  payload first (key `mcpOAuth`), then `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`. A token
  counts as expired 60 seconds before its expiry time. The reader is `src/scripts/lib/claude-tokens.ts`.

Worth knowing about the Claude Code path:

- **A missing token does not look like a missing token.** The streamable POST answers 401, mcporter falls back to
  legacy SSE, and that GET answers 405. The visible error is `SSE error: Non-200 status code (405)`. So the kit
  reports a missing or expired token up front on stderr, as `[auth] <server>: ...`. A server with no token is still
  tried, because many remote servers are open.
- **Expired tokens are reported, not refreshed.** Refresh tokens rotate; spending Claude Code's copy would break the
  server inside the app. Authorise again with `/mcp` in Claude Code.
- **Reusing the app's token also avoids client allow-lists.** Some vendors (Figma) answer 403 to an OAuth client they
  did not approve. Do not register a new client to "do it properly": that is the path that fails.

### The script store

Everything lives in `~/.genesis-tools/scripts/`:

```text
~/.genesis-tools/scripts/
  .git/, .gitignore               local git repo, branch main
  config.json                     the remote decision (never committed)
  package.json, node_modules/     the scripts' own npm dependencies
  tsconfig.json                   generated @gt/* aliases into this checkout
  cache/registry.json             last provider scan (mode 600, never committed)
  cache/tools.json                tools/list per server (mode 600, never committed)
  persisted/_journal.json         metadata, tags, gate, run history
  persisted/<name>/<name>.ts      your script
  persisted/<name>/<name>.tools.ts  generated bindings
  persisted/<name>/...            sidecars
  trash/                          where rm and create --force put things
```

- The store becomes a git repo on its first scaffold. `.gitignore` covers `node_modules/`, `cache/`, `trash/`,
  `persisted/*/out/`, `persisted/*/out-*/`, `persisted/*/.cache/` and `*.tmp`.
- Every mutating verb (`create`, `regen`, `rename`, `tag`, `rm`) commits its change. It stages an explicit allow-list
  (`.gitignore`, `package.json`, `tsconfig.json`, `persisted/`), never the credential cache, and untracks `cache/`,
  `trash/` and `node_modules/` if they were ever committed. `run` does not commit; the next mutating verb sweeps up
  the run counters.
- A commit works without a git identity (it falls back to `genesis-scripts <scripts@genesis-tools.local>`), and it
  skips commit signing and hooks. A failed `git init` disables versioning with a logged warning; the scripts still work.
- With auto-push on, every store commit is pushed. A failed push prints a warning and never fails the verb.
- Everything in a script's folder is committed, except `out/`, `out-*/` and `.cache/`. Keep secrets out of sidecars,
  or put them under `.cache/`. The committed `tsconfig.json`, the journal and the script headers also hold absolute
  paths of this machine, so keep a remote private.
- No remote exists until you decide. `create` prints a one-line offer until you run `remote <url>` or `remote --none`.
- The journal takes a cross-process lock (`_journal.json.lock`) for each change, so a `run` and a `tag` at the same
  time do not lose an update.
- `rm` moves the folder to `trash/<timestamp>-<name>/`. `create --force` copies the replaced files to
  `trash/<timestamp>-<name>.ts` and `trash/<timestamp>-<name>.tools.ts`.

### Bindings generation

The JSON-schema-to-TypeScript step is this tool's own, not `mcporter emit-ts`. Tested on 2026-07-28 against mcporter
0.12.3, `emit-ts` emitted positional parameters in schema order, so a tool with an optional property before a required
one did not compile (`TS1016`), and it flattened nested objects to `Record<string, unknown>`. MCP tools take one
arguments object, so the bindings take one typed object too. mcporter's runtime still does the transport,
connections and result unwrapping.

### Facts worth knowing before you design a script

- **There is no batching.** JSON-RPC batching was removed from MCP in the 2025-06-18 spec revision. `kit.all()` fires
  concurrent requests over one open session; that is the only lever.
- **Nothing in this tool costs money.** A server you call may.
- **The tool needs Bun; git gives the store its history.** Claude Code tokens come from the macOS keychain; on other
  systems, or when the keychain entry is missing or unreadable, they come from the credentials file.

## Configuration

- **Servers** come from the editor configs that mcp-manager reads. Add, enable or disable them with
  `tools mcp-manager`.
- **`config.json`** in the store holds the remote decision, written by `remote`: `remote.url`, `remote.declined`
  (`true` after `--none`), `remote.autoPush` (default `false`) and `remote.decidedAt`.
- **`GENESIS_TOOLS_HOME`** moves the whole data root: the store becomes `$GENESIS_TOOLS_HOME/.genesis-tools/scripts`.
  Tests use it as a sandbox.
- **`CLAUDE_CONFIG_DIR`** moves the Claude Code home, and so the `.credentials.json` fallback.

## For agents

- `--json` works on `servers`, `tools`, `describe`, `list`, `show` (metadata only) and `doctor`. `call --json` prints
  the raw MCP result envelope.
- stdout carries the `servers` table, the `list` rows, the `call` text, the source part of `show`, the script
  directory that `create` prints last, and every `--json` payload. `tools`, `describe` and `doctor` print their text
  report on stderr, and so does the metadata block of `show`. To pipe a report, use `--json` or `2>&1`. Progress
  (`probing N server(s): ...`), warnings, counts and hints also go to stderr.
- A failed command exits 1 with `ERROR: <message>` on stderr (a usage mistake prints commander's `error: ...`).
  `run` exits with the script's exit code, and `git` with git's.
- `call` exits 0 when the tool returns an error result. Use `--json` and check `isError`.
- `doctor` exits 0 whatever it finds. Read `findings[].level` (`ok`, `warn`, `err`) from `doctor --json`.
- **`servers --json` prints live secrets.** It shows each connection as the dialler sees it, with header and `env`
  values, and the gateway token when one exists. Do not paste it into a ticket, a PR or a chat.
- The genesis-tools plugin ships the `mcp-scripting` skill
  (`plugins/genesis-tools/skills/mcp-scripting/SKILL.md`). It sends an agent here when it is about to call the same
  MCP tool more than about three times, or needs a server its session did not load.

## Troubleshooting

- **`SSE error: Non-200 status code (405)`.** The remote server needs a token and has none. Look for the `[auth]`
  line above it. Authorise the server with `/mcp` in Claude Code, or with `tools mcp-manager auth login <server>` for
  a gateway server.
- **A new or changed server does not show.** The caches never expire. Run `tools scripts tools '<server>.*' --refresh`.
  If it is disabled everywhere, `servers --all` shows it.
- **A server that you fixed still fails.** Its old failure sits in the tool cache. `tools scripts tools '<server>.*'
  --refresh` probes it again. `doctor` lists every cached failure.
- **`No enabled MCP server matched: <name>`.** The server is disabled or unknown, or `call` got the name in another
  case. Check `tools scripts servers --all`.
- **`port <n> is in use by another process`.** Something else holds the gateway's port. Run
  `tools mcp-manager gateway status`.
- **`launchd agent ... is installed but /health is not ok`.** The gateway's launchd agent did not start. Read the log
  file the message names, or run `tools mcp-manager gateway status`.
- **`Cannot find module 'commander'` from a direct `bun <file>`.** The store has no `node_modules` yet. Run the script
  once through `tools scripts run`, or run `bun install` in the store.
- **The import of `@gt/scripts/kit` fails.** The store's alias points at a moved or removed checkout. Any `run` or
  `create` rewrites it; `doctor` shows where it points.
- **`regen` says a server `did not respond, so their bindings would be dropped`.** Fix the server and retry, or pass
  `--force` to accept the loss.
- **A script is missing from `list`.** It is gated to another project: add `--all`. If its gate directory is gone,
  `tag <name> --ungate` brings it back.
- **A script came back from `trash/` but `run` says `No script named`.** `rm` dropped its journal entry, and the
  printed `mv` restores only the files. Before you move the folder back, run `create <name> --import <its selectors>`,
  then copy your `<name>.ts` and sidecars from the trash folder over the new files. If you already moved it back, add
  `--force`: `create` then copies your `<name>.ts` to `trash/<timestamp>-<name>.ts` first, so copy that back over the
  new file. A direct `bun <file>` also runs the script, without a run record.
- **`list` is empty although scripts exist on disk.** `persisted/_journal.json` does not parse. Each command that reads
  the journal (all but `doctor`) then saves a copy as `_journal.corrupt-<timestamp>.json` and treats the journal as
  empty, so each such command saves one more copy. The next `create` writes a new journal that holds only the new
  script. `run`, `show`, `tag`, `rm` and `regen` answer `No script named`, and `rename` moves the files but finds no
  entry to change. Copy the entries back from a saved copy.
- **`doctor` reports a journal entry whose file is missing.** `tools scripts rm <name>` drops the stale entry.

## Related

- [mcp-manager](../mcp-manager/README.md): the server configs this tool reads, the OAuth gateway, `auth login`,
  `enable` and `disable`.
- [chrome-devtools](../chrome-devtools/README.md): `tools chrome-devtools scaffold <name> --recipe <recipe>` writes a
  CDP script into this store, without an MCP server. Run it with `tools scripts run <name> -- --port 9222`.
