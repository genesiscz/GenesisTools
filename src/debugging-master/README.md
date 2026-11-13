# tools debugging-master

A runtime debugging kit for people and LLM agents: it copies a logging snippet into your project, collects what
the instrumented code sends into a named session, and reads that session back in a compact form that keeps an
agent's context small. It is the data side of the `genesis-tools:debugging-master` plugin skill, which teaches the
hypothesis-driven workflow.

## Quick start

```bash
# Start the ingest server and live dashboard in the background (port 7243)
tools debugging-master dashboard serve up

# In the project root: copy llm-log.ts into src/utils and create the session "auth-race"
tools debugging-master start --session auth-race --path src/utils

# Print a ready-to-paste log call, already wrapped in @dbg markers
tools debugging-master snippet dump userData

# After you reproduce the bug: read the compact timeline
tools debugging-master get

# Show the shape of a large value that the timeline cut to a ref
tools debugging-master expand d2

# Remove every @dbg block (stashed in git first) and archive the session log
tools debugging-master cleanup --blocks --clean-logs
```

The snippet (`llm-log.ts` or `llm-log.php`) sends every entry over HTTP, so a server must run while the code runs.
`dashboard serve up` runs it in the background. `start --serve` runs it in the foreground instead and blocks that
terminal. When you are done, `cleanup --blocks` stashes the instrumentation in git before it removes it, so you can
put it back later.

## Commands

### Global options

These go before or after the subcommand.

| Option             | What it does                                           |
|--------------------|--------------------------------------------------------|
| `--session <name>` | Session to use: exact name, else closest fuzzy match.  |
| `--format <type>`  | `ai` (default), `json` or `md`. Only `get` reads it.   |
| `--pretty`         | Colors for `get`. `tail` colors by itself on a tty.    |
| `-v, --verbose`    | Verbose logging.                                       |
| `--readme`         | Print this README and exit.                            |

When you leave out `--session`, the tool picks a session by itself. See "How a session is picked" below.

### Set up and instrument

**`start`**: configure the project in the current folder and start (or re-use) a session.

```bash
tools debugging-master start --session auth-race --path src/utils
tools debugging-master start --session laravel-bug --language php --path app/Support
tools debugging-master start --session browser-bug --serve --port 7250
```

| Flag                | Default        | What it does                          |
|---------------------|----------------|---------------------------------------|
| `--path <dir>`      | current folder | Snippet folder. It must exist.        |
| `--language <lang>` | detected       | `typescript` or `php`.                |
| `--serve`           | off            | Run the server in the foreground.     |
| `--port <n>`        | `7243`         | Server port, also in the snippet.     |

What `start` does, in order:

1. Takes the session name from `--session`. Names may hold letters, digits, `-` and `_` only. Without a terminal,
   `--session` is required; on a terminal it asks for a name.
2. Picks the language: `--language`, else `typescript` when the folder has `tsconfig.json`, else `php` when it has
   `composer.json`, else `typescript`.
3. Copies `llm-log.ts` or `llm-log.php` into `--path` (or the current folder). It overwrites the copy every time,
   writes your Mac's LAN address in place of `__LAN_IP__`, and writes `--port` into the `PORT` constant.
4. Creates `<name>.jsonl` and `<name>.meta.json` in the sessions folder. When the session already exists, it keeps
   the old entries and prints `Session re-used` with the time of the last log.
5. Saves the snippet path and the language for this project folder in `config.json`.
6. Prints the lines to add to your code, for example:

   ```ts
   import { dbg } from './src/utils/llm-log';
   dbg.session('auth-race');
   ```

   For PHP it prints `require_once __DIR__ . '/<path>/llm-log.php';` and `LlmLog::session('<name>');`. Both
   paths are relative to the project root, not to the file you instrument, so change them to fit that file.

With `--serve`, it builds the dashboard once if it is not built, then listens on `--port` and prints the ingest URL,
the health URL, the dashboard URL and a QR code. When the port already answers `/health` (for example
`dashboard serve up` runs), it re-uses that server and returns. When another program holds the port, it exits with
`Port <n> is in use by another process`.

`start` does not read the saved snippet path back. Pass `--path` on every run, or it copies the snippet into the
current folder.

**`snippet <type> <label>`**: print instrumentation code wrapped in `// #region @dbg` and `// #endregion @dbg`.

```bash
tools debugging-master snippet dump userData
tools debugging-master snippet timer db-query
tools debugging-master snippet assert valid-id --language php
tools debugging-master snippet dump componentState --http
```

- `<type>`: `dump`, `info`, `warn`, `error`, `timer`, `checkpoint`, `assert`, `snapshot` or `trace`. A `timer`
  prints a start and an end call around a placeholder line.
- `<label>`: the label or message. Quotes and backslashes are escaped for you.
- `--language <lang>`: `typescript` or `php`. Without it, the language that `start` saved for the current folder,
  else `typescript`.
- `--http`: print a raw HTTP post instead of a `dbg.*` or `LlmLog::*` call, for code that cannot import the
  snippet (a browser console, a page script). TypeScript gets `fetch`. PHP gets Guzzle when `composer.json` in the
  current folder requires `guzzlehttp/guzzle`, else `file_get_contents`.

The output uses placeholder names (`data`, `condition`, `vars`, `$data`) that you replace. The `--http` form always
posts to `http://127.0.0.1:7243/log/<session>`, with the most recent session (or `default`). Edit the URL when your
server runs on another port or host.

### Read the logs

Read in three steps, from cheap to expensive: `get` (timeline), `expand <ref>` (shape), then `expand <ref> --full`
or `--query` (values).

**`get`**: print the compact timeline of a session.

```bash
tools debugging-master get
tools debugging-master get -l dump,error
tools debugging-master get -l timer
tools debugging-master get --last 5
tools debugging-master get --hypothesis H1
tools debugging-master --session auth get --format json
```

- `-l, --level <levels>`: comma-separated levels. `timer` is an alias that merges each start and end pair into one
  line with its duration. A start or an end without its partner is left out. This filter, like `-l` in `tail` and
  `diff`, also keeps every `raw` entry.
- `--last <n>`: only the last N entries (applied after the filters).
- `--hypothesis <tag>`: only entries tagged with this hypothesis (`h`), plus every `raw` entry.

The output, abridged:

```text
Session: auth-race (24 entries, 4.2s span)

Summary:
  5 dump  8 info  2 error  3 checkpoint  3 trace  1 assert (0 failed)  1 timer-pair (avg 341ms)

File: ~/Projects/app/src/api.ts
    #1  14:32:05  info        starting auth flow
    #2  14:32:05  dump        userData                       [ref:d2] 2.4 KB
File: ~/Projects/app/src/auth/handler.ts
    #4  14:32:05  checkpoint  after-query
    #6  14:32:05  error       auth token expired             [ref:e6] 890 B

Tip: Expand a ref → tools debugging-master expand d2
```

A `dump`, `error`, `snapshot` or `trace` entry whose data (or stack) is longer than 200 characters as JSON gets a
ref instead of its value: `d`, `e`, `s` or `t`, then the entry number. An `assert` line ends in `PASS` or `FAIL`.

**`expand <refId>`**: show one ref.

```bash
tools debugging-master expand d2                         # skeleton of the value (the default)
tools debugging-master expand d2 --schema typescript     # as a TypeScript interface
tools debugging-master expand d2 --schema schema         # as a JSON Schema
tools debugging-master expand d2 --full                  # the whole value
tools debugging-master expand d2 --query 'items[*].name' # a JMESPath projection
```

- `--schema <mode>`: `skeleton` (default), `typescript` or `schema`.
- `--full`: the complete raw data.
- `--query <jmes>`: a JMESPath expression over the data.

The number in a ref is the entry's number in the whole session, so a ref from a filtered `get` still works. An `s`
ref shows the snapshot variables. An `e` ref shows the error data with its stack under `_stack`.

**`tail`**: print the last entries, then follow the session live until Ctrl+C.

```bash
tools debugging-master tail
tools debugging-master tail -n 50 -l error,warn
```

- `-l, --level <levels>`: comma-separated levels. There is no `timer` alias here; use `timer-start,timer-end`.
- `-n <count>`: how many existing entries to print first (default `10`).

**`sessions`**: list every session with its entry count, time span, project folder and last activity. A session
with activity in the last hour is marked `active`.

```bash
tools debugging-master sessions
```

**`diff`**: compare two sessions, for example a failing run and a passing run.

```bash
tools debugging-master diff --session auth-fail --against auth-pass
tools debugging-master diff --session auth-fail --against auth-pass -l checkpoint
```

- `--against <session>` (required): the second session. The first is `--session`, or the picked session.
- `-l, --level <levels>`: compare only these levels. There is no `timer` alias here either.

For each `checkpoint`, `dump`, `snapshot`, `trace` and `assert` label, it prints whether the label is missing on
one side, identical, or different (with both values cut to 80 characters). Then it compares timer durations with
the percent change, and counts the entries that only one session has. `diff` does not change the recent session.
When no recent session was saved before, the `--against` session becomes the recent one.

### Clean up

**`cleanup`**: remove the instrumentation, archive the session log, or both. With no flag it prints its help and
does nothing. Run it in the project root.

```bash
tools debugging-master cleanup --blocks --clean-logs              # the usual "done debugging" command
tools debugging-master cleanup --blocks --stash-message "auth bug"
tools debugging-master cleanup --blocks --no-stash
tools debugging-master cleanup --blocks --repair-formatting
tools debugging-master cleanup --clean-logs ./debug-logs/
```

| Flag                    | What it does                                       |
|-------------------------|----------------------------------------------------|
| `--blocks`              | Remove every `@dbg` region from the source files.  |
| `--clean-logs [path]`   | Move the session log out of the sessions dir.      |
| `--repair-formatting`   | Undo whitespace-only diffs. Implies `--blocks`.    |
| `--no-stash`            | No git stash first. The snippet file stays.        |
| `--stash-message <msg>` | Note for the stash (default: a timestamp only).    |

What `--blocks` does:

1. Scans `*.ts`, `*.tsx`, `*.js`, `*.jsx` and `*.php` below the current folder, without `node_modules`, `vendor`,
   `.git`, `dist` and `build`. A region marker without its partner is reported and that region is skipped.
2. Runs `git stash push -u` on every file with a block, plus every `llm-log.ts` and `llm-log.php`. The message is
   `@dbg instrumentation: <note> (<UTC time>)`. When the stash fails, it removes no block. A `--clean-logs` in the
   same command still archives the session log.
3. Removes the blocks that are still there (for example instrumentation that was committed).
4. Runs `git diff` on the changed files. It lists files with real changes left, and files with whitespace-only
   changes. `--repair-formatting` runs `git checkout` on the whitespace-only files.

Only the stash takes the snippet file out of the working tree. With `--no-stash`, step 2 does not run, so the copied
`llm-log.ts` or `llm-log.php` stays in the project. Delete it yourself.

The stash holds whole files. Other edits in a file with a `@dbg` block move into the stash too. To get the
instrumentation (and those edits) back, use `apply`, not `pop`, so the stash stays:

```bash
git stash list                 # find the stash index
git stash show -p stash@{0}    # preview it
git stash apply stash@{0}      # put the @dbg blocks and the snippet back
git stash drop stash@{0}       # discard it when you are sure
```

What `--clean-logs` does: it archives the picked session (or `--session`) as
`<UTC timestamp>-llmlog-<session>.jsonl` and `.meta.json`. Without a path, it moves them into the system temp
folder (`os.tmpdir()`, which on macOS is `$TMPDIR` under `/var/folders`, not `/tmp`), which the system may empty.
With a path, it creates the folder, copies the files there and deletes the originals. It prints the archive path.
It never deletes log data.

### Dashboard and server

**`dashboard build`**: compile the dashboard frontend (`vite build` in `src/debugging-master/dashboard/`). Every
server start builds it once when `dist/` is missing, so you need this only after you change the frontend.

**`dashboard serve`**: the standard GenesisTools dashboard lifecycle for the shared log server. Without a
subcommand it runs `up` with the defaults; `-i, --interactive` shows a menu instead.

```bash
tools debugging-master dashboard serve up             # start in the background
tools debugging-master dashboard serve up -f          # run in the foreground
tools debugging-master dashboard serve status         # pid, port, uptime, launchd state
tools debugging-master dashboard serve open           # make sure it runs, print the URL and a QR code, open it
tools debugging-master dashboard serve open \
    -q source=debugging-master \
    -q session=auth-race                              # open one session directly
tools debugging-master dashboard serve logs -n 100    # last lines of the background log
tools debugging-master dashboard serve down
```

| Subcommand     | Flags                                                 |
|----------------|-------------------------------------------------------|
| `up`           | `-f`, `-p <n>`, `--force`, `--no-open`, `-i`          |
| `down`, `stop` | `--no-force` (no SIGKILL after the grace period)      |
| `restart`      | the same flags as `up`                                |
| `status`       | none                                                  |
| `attach`       | `-n <n>` (default 50). Ctrl+C stops only the tail.    |
| `logs`         | `-n <n>` (default 200)                                |
| `open`         | `-p <n>`, `--no-qr`, `--no-open`, `-q <kv>` (repeat)  |
| `install`      | `--force`, `-p <n>`                                   |
| `uninstall`    | none                                                  |

The long forms are `-f, --foreground`, `-p, --port`, `-i, --interactive`, `-n, --lines` and `-q, --query`.

`install` registers a launchd agent that starts the server at login and restarts it after a crash. `uninstall`
removes it.

`-p, --port <n>` does not move this server. The server process always gets port 7243, and `-p` changes only the
port that `up`, `restart`, `open` and `install` check, wait on and open. So `dashboard serve up -p 7250` starts a
server on 7243 and then warns that it did not become ready on 7250. To use another port, run
`start --serve --port <n>`.

`--force` stops a process that holds the port before the start. The first background `up` on a terminal asks
whether to install the launchd agent, and remembers the answer.

## How it works

### The flow

1. `start` copies the snippet and creates the session.
2. Your code calls `dbg.*` (TypeScript) or `LlmLog::*` (PHP). Every call posts one JSON entry to
   `POST /log/<session>` on the server.
3. The server appends the entry to `~/.genesis-tools/debugging-master/sessions/<session>.jsonl` and updates the
   session's last activity time.
4. `get`, `expand`, `tail`, `diff` and the dashboard read that file.
5. `cleanup` removes the instrumentation and archives the file.

Since 2026-06-23 (commit `985e6b5f31`) the snippet only sends over the network. It does not write files. Nothing is
logged while no server runs, and a PHP web request can fail (see Troubleshooting).

### The snippet

Both snippets have no dependencies. The TypeScript one needs `fetch` and `AbortSignal.timeout` (Node 18 or later,
Bun, or a browser). The PHP one needs PHP 8.0 or later and `ext-curl`.

- On the first call it probes `/health` on each host in `HOSTS` (your LAN address, `127.0.0.1`, `localhost`) at
  the same time. The first one that answers is used for every later call. When none answers, the next call probes
  again.
- Each request and each probe has a 2 second timeout (`TIMEOUT_MS`). The two snippets wait and report differently:
  - TypeScript: calls do not wait for the server. When the server cannot be reached, it prints
    `[dbg] ingest failed: ...` to stderr once and goes on.
  - PHP: every call waits for its request, up to 2 seconds. While no host answers, every call probes again and
    prints `[dbg] ingest unreachable on <hosts>:<port>` each time. When a post fails after a good probe, it prints
    `[dbg] ingest failed: ...` once. It writes both to `STDERR`, which only the PHP command line defines; see
    Troubleshooting for web requests.
- Every entry carries `ts`, and the `file` and `line` of the caller. By default it also carries the full call
  stack. Turn that off for one call with `{ stack: false }`, or for all calls with
  `dbg.configure({ captureStackByDefault: false })`. The TypeScript snippet reads `file` and `line` from that
  stack, so without it they are `unknown` and `0`.
- Without `dbg.session('<name>')`, entries go to the session `default`.

The API (PHP has the same methods as static calls on `LlmLog`):

| Method                                | Level                     |
|---------------------------------------|---------------------------|
| `dbg.dump(label, data, opts?)`        | `dump`                    |
| `dbg.info(msg, data?, opts?)`         | `info`                    |
| `dbg.warn(msg, data?, opts?)`         | `warn`                    |
| `dbg.error(msg, err?, opts?)`         | `error`, with the stack   |
| `dbg.timerStart(label, opts?)`        | `timer-start`             |
| `dbg.timerEnd(label, opts?)`          | `timer-end`, `durationMs` |
| `dbg.checkpoint(label, opts?)`        | `checkpoint`              |
| `dbg.assert(cond, label, ctx?, opts?)`| `assert`, `passed`        |
| `dbg.snapshot(label, vars, opts?)`    | `snapshot`                |
| `dbg.trace(label, data?, opts?)`      | `trace`                   |

`opts` is `{ h?, stack? }`. `h` is a hypothesis tag that `get --hypothesis` and the dashboard filter on:

```ts
// #region @dbg
dbg.dump('cart', cart, { h: 'H1' });
// #endregion @dbg
```

⚠️ Never log a token, password, cookie or other secret. The session log is a plain file, and the dashboard server
has no authentication and answers requests from any browser origin, so a web page you open can read what you logged.

Wrap every debug line, the import too, in its own `// #region @dbg` and `// #endregion @dbg` pair. `cleanup` finds
only lines inside these markers. A bare `dbg.info(...)` stays in the code and can be committed by accident.

### The server

`start --serve`, `dashboard serve` and `tools task dashboard` run the same HTTP server. It listens on
`127.0.0.1:7243` by default and has no authentication. It answers:

- `GET /health`: `{"status":"ok","uptime":...}`.
- `POST /log/<session>`: append one entry. A body that is not JSON is kept as a `raw` entry, an unknown `level`
  becomes `raw`, and a missing `ts` is set to the time of arrival. The session file is created when it is missing.
- `DELETE /log/<session>`: empty the session file.
- The dashboard page, and a JSON API under `/api/sessions` (list, entries, server-sent event streams, expand,
  clear, delete) that the dashboard uses.

CORS allows every origin, so a page in the browser can post to it.

Since 2026-09-17 (commit `04c1a2806d`) the server listens on loopback only. Before, it listened on `0.0.0.0`.
`start --serve` still prints LAN URLs and a QR code; see Troubleshooting for how to reach it from a phone.

### The dashboard

The dashboard ("Log Viewer (dbg + task)") shows debugging-master sessions and `tools task` sessions in one list,
newest first, with their live state. A session view streams new entries and has level and hypothesis filters,
text search, sort order, pause and autoscroll, and expandable JSON. A mosaic view shows all active sessions
together. The URL `?source=debugging-master&session=<name>` opens one session.

Display settings (fonts and sizes, timestamps on every line, on change or never, line ids, line wrap, full JSON
context) and the live pool settings (how long a finished session stays in the pool, default one hour) are saved in
the browser's local storage, not on disk.

The dashboard can clear a session (empty its file) or delete it. Delete removes the `.jsonl` and `.meta.json` for
good; it does not archive them.

### How a session is picked

Every command that reads a session picks it like this:

1. With `--session <name>`: that exact name, else the closest fuzzy match among all sessions. The pick becomes
   the "recent session".
2. Without it: the recent session, when it had activity in the last hour.
3. Else the one session with activity in the last hour.
4. When several sessions are active, it stops and prints a `--session` command for each. When none is active, it
   stops with `No active sessions`.

"Activity" is the `lastActivityAt` time in the session's meta file. Creating the session sets it, and every entry
that arrives through the server updates it. Re-using a session with `start` does not.

### Where data lives

```text
~/.genesis-tools/debugging-master/config.json                 project settings and the recent session
~/.genesis-tools/debugging-master/sessions/<name>.jsonl       one JSON entry per line
~/.genesis-tools/debugging-master/sessions/<name>.meta.json   project path, created and last activity times
~/.genesis-tools/dashboards/debugging-master.pid              pid of the background server
~/.genesis-tools/dashboards/debugging-master.config.json      dashboard preferences (bindHost, launchd)
~/.genesis-tools/logs/debugging-master.bg.log                 log of the background server
~/Library/LaunchAgents/com.genesis-tools.log-dashboard.plist  only after `dashboard serve install`
src/debugging-master/dashboard/dist/                          the built dashboard frontend
```

The tool calls no paid API. `cleanup` needs `git` and a git repository.

## Configuration

`~/.genesis-tools/debugging-master/config.json` is written by `start` (the project entry) and by every command
that picks a session (`recentSession`):

```json
{
  "projects": {
    "/path/to/app": { "snippetPath": "/path/to/app/src/utils/llm-log.ts", "language": "typescript" }
  },
  "recentSession": "auth-race"
}
```

`snippet` reads `language` for the current folder. Nothing reads `snippetPath` back yet.

`~/.genesis-tools/dashboards/debugging-master.config.json` holds the dashboard preferences. `"bindHost": "0.0.0.0"`
opens the `dashboard serve` server to the LAN, and `"127.0.0.1"` (the default) keeps it local.

Environment variables:

- `DASHBOARD_BIND_HOST`: the address the server listens on. `dashboard serve` sets it from `bindHost`. Set it
  yourself for `start --serve`, for example `DASHBOARD_BIND_HOST=0.0.0.0`.
- `LOG_DASHBOARD_PORT`: the port of the background server process (default `7243`). `dashboard serve` sets it.
- `GENESIS_TOOLS_HOME`: the folder that holds `.genesis-tools` (default: your home folder).

In the copied snippet you can edit `HOSTS`, `PORT` and `TIMEOUT_MS` at the top. The next `start` overwrites the
copy, so make lasting changes with `--port` instead.

## For agents

- The plugin skill
  [`genesis-tools:debugging-master`](../../plugins/genesis-tools/skills/debugging-master/SKILL.md) holds the
  workflows: hypothesis-driven debugging, quick checks, timers, flow tracing and run comparison. There is no MCP
  server; the CLI is the interface.
- Read in three steps to keep the context small: `get` (with `-l`, `--last`, `--hypothesis`), then `expand <ref>`
  for the shape, then `--query` or `--full` for values. Do not go to `--full` before you know the shape.
- Generate instrumentation with `snippet` so the `@dbg` markers are always there.
- `--format json` prints `{"output": "<the timeline text without colors>"}`. It is the same text in a JSON
  string, not a list of entries. `--format md` prints the same text as `ai`. For raw entries, read the `.jsonl`
  file, or call `GET /api/sessions/<name>/entries?since=<n>&limit=<n>` on the server (at most 5000 per call).
- Without a terminal, `start` needs `--session`. `tail`, `start --serve` and `dashboard serve up -f` do not exit
  by themselves; run them in the background.
- Pass `--session` when more than one session can be active, so the pick does not fail.
- Invalid input (a port, a language, a snippet type, a ref id) prints an error and exits 1.
- A failed session pick (`No active sessions`, `Multiple active sessions found`, `Session "<name>" not found`)
  prints `ERROR: <message>` on stderr and exits 1.
- `cleanup --clean-logs` exits 0 even when it archives nothing. Check its output for `Logs archived to:`.

## Troubleshooting

- **`[dbg] ingest failed: no dbg ingest reachable on ...:7243`** (TypeScript) or
  **`[dbg] ingest unreachable on ...:7243`** (PHP) in your app's output. The snippet reached no server. There are
  two causes:
  - No server runs on that port. Run `tools debugging-master dashboard serve up`, or `start --serve` in another
    terminal.
  - The server runs, but it listens on `127.0.0.1` only, and the code runs somewhere else: a Docker container, a
    VM, a phone browser or another machine. Use `DASHBOARD_BIND_HOST=0.0.0.0` with `start --serve`, or set
    `"bindHost": "0.0.0.0"` for `dashboard serve` and run `dashboard serve restart`. Anyone on the network can
    then read, post and delete logs.
- **A PHP web request (PHP-FPM, Apache) stops with `Undefined constant "STDERR"`.** The PHP snippet writes its
  failure messages to `STDERR`, and only the PHP command line defines that constant. So the first `LlmLog::*` call
  that cannot reach the server throws an `Error`. Keep the server running and reachable while instrumented web code
  runs.
- **A phone or another computer cannot open the URL or QR code from `start --serve`.** The server listens on
  `127.0.0.1` only. Run `DASHBOARD_BIND_HOST=0.0.0.0 tools debugging-master start --session <name> --serve`, or
  set `"bindHost": "0.0.0.0"` for `dashboard serve` (then `dashboard serve restart`). Anyone on the network can
  then read, post and delete logs.
- **`No active sessions` or `Multiple active sessions found`.** Pass `--session <name>`. A session counts as
  active for one hour after its last entry. After `start` re-uses an older session, the session is not active
  until its first new entry arrives.
- **Entries land in a session called `default`.** The code did not call `dbg.session('<name>')` or
  `LlmLog::session('<name>')`. Read those entries with `tools debugging-master --session default get`. A session
  that `start` did not create (`default`, or a name given only to `dbg.session()`) has no `.meta.json`, so it is
  never active and never picked by itself. `sessions` lists it with `unknown` as its project and last activity.
- **`Port 7243 is in use by another process`.** Another program holds the port. Use `start --port <n>`; `start`
  writes the new port into the snippet. The `snippet --http` output still names 7243, so edit its URL.
- **`tail -l timer` or `diff -l timer` shows no timers.** Only `get` knows the `timer` alias. Use
  `timer-start,timer-end`.
- **`Stash failed: ...` from `cleanup --blocks`.** No `@dbg` block was removed, but a `--clean-logs` in the same
  command still archived the session log. Fix the git problem it names, or add `--no-stash` to remove the blocks
  without a stash.
- **`unclosed/orphan @dbg region(s) found`.** A `#region @dbg` has no `#endregion @dbg` (or the reverse). Fix the
  markers at the lines it prints and run `cleanup` again.
- **Other edits disappeared after `cleanup --blocks`.** They are in the stash with the instrumentation, because the
  stash holds whole files. `git stash apply` brings them back.
- **`No active session found`** from `cleanup --clean-logs`, and nothing is archived. Pass `--session <name>`.
- **The dashboard page says "dashboard not built" (HTTP 503).** Run `tools debugging-master dashboard build`.

## Related

- [`tools task`](../task/README.md): its sessions show in the same dashboard, and `tools task dashboard` runs the
  same server.
- [The design record](../../docs/debugging-master.brainstorm.md): the research and the decisions behind JMESPath,
  hypothesis tags and the CLI-only interface. Its "file mode" no longer exists; the snippet has sent over HTTP
  since 2026-06-23.
