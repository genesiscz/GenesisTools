# tools services

`tools services` lists every long-running GenesisTools server on this Mac, shows which ones still run code from
before the last change, restarts them, starts and stops the registered servers as one fleet, and stops on-demand
servers nobody uses. Use it after a pull or an edit, when a dashboard or an API server must pick up the new code.
Agent sessions (Claude Code, Codex, Grok, cursor-agent, the task runner, and anything started inside one) are never listed,
so nothing here can restart or stop one.

## Quick start

```bash
tools services                               # the table: port, pid, uptime, launchd or detached, code age
tools services restart --stale               # restart every service on old code, no prompt
tools services restart mcp-gateway youtube   # restart these services by id
tools services up                            # start every registered server that is not listening
tools services down --except dev-dashboard   # stop the detached fleet, but keep one
tools services idle install                  # stop on-demand servers after 24 h without a client
```

## Commands

| Command | What it does |
|---|---|
| `list` | The running services and whether each runs the current code (the default) |
| `restart [ids...]` | Restart services on the current code; launchd jobs go through launchd |
| `up [keys...]` | Start the registered servers that are not listening |
| `down [keys...]` | Stop the registered detached servers; a launchd job is never stopped |
| `reap-idle` | Stop detached servers that no client used for `--idle-hours` |
| `idle install` | Register the daemon task that runs `reap-idle` every 15 minutes |
| `idle uninstall` | Remove that task |
| `idle status` | Print whether that task is registered |

The tool also takes `-v, --verbose` (more logging) and `--readme` (print this page).

### List

```bash
tools services              # same as `tools services list`
tools services list --json  # the rows, with the changed files, as JSON
```

The table has one row per service: `SERVICE` (the id), `PORT`, `PID` (the root process), `UP` (the root's age),
`MANAGED` (`launchd <label>` or `detached`) and `CODE` (`current`, or `old: N file(s) changed`). When a service runs
old code, the table ends with the command that restarts them.

**Old code** means a commit since the process started, or an uncommitted edit newer than it, under the service's own
`src/<tool>/` or `src/utils/`. How it is judged: [Old code](#old-code).

### Restart

```bash
tools services restart                  # pick in a terminal; services on old code are preselected
tools services restart --stale          # every service on old code
tools services restart --all            # every listed service, launchd jobs included
tools services restart daemon youtube   # these ids
```

- An id is the `SERVICE` column: a registry key (`youtube`), or a launchd label without `com.genesis-tools.`
  (`daemon`). An id that is not running stops the command with the list of running ids.
- `--all` wins over `--stale`, and both win over named ids.
- Without a terminal, name the ids or pass `--stale` or `--all`. Otherwise it prints that and exits 1.
- A restart interrupts the clients of that server: an open dashboard tab, or an agent that talks through the proxy or
  the MCP gateway.

`tools update` offers the same restart after it pulls. It runs `tools services list --json`, and when services run old
code it asks whether to restart them now (default no). Without a terminal it prints the command instead.

### Up and down

```bash
tools services up                            # start what is not listening: API servers first, then dashboards
tools services up youtube dev-dashboard      # only these registry keys
tools services up --except spotify,monitor   # every default server but these
tools services up ai-proxy                   # a server outside the default set runs only when named
tools services down                          # stop the detached ones, dashboards first; launchd jobs stay up
```

- The arguments are registry keys ([the table below](#registry-keys)). `--except <keys>` takes a comma-separated list
  and always wins.
- With no keys, `up` and `down` take every registry entry that has a launch command, except five: the MCP gateway,
  the proxy, the YouTube extension dev server, the cloud dashboard and the artifact server. Something else keeps them
  running or they need their own setup, and a bare `down` must never stop the MCP gateway or the proxy. The artifact
  server's registered start serves only the shipped kit gallery, which the artifact library already shows. Name one
  to include it. To serve a folder, use `tools artifact serve <folder>`.
- A named key that is not registered, or has no launch command, stops the command before it starts or stops anything
  (exit 1).
- The result table has `SERVICE`, `PORT`, `RESULT` and `DETAIL`. `RESULT` is `started`, `running`, `stopped`,
  `not running`, `launchd` or `failed`. Any `failed` row makes the exit code 1.

`up` reads the whole registry in `src/utils/ui/dashboards.ts`, so a newly registered dashboard is included without
editing a list. `tools dashboards up|down` runs each dashboard's own lifecycle verbs over a fixed list of eight
servers (seven dashboards and the YouTube API server), and
stays for that.

### Idle shutdown

```bash
tools services idle install --idle-hours 24   # daemon task, every 15 minutes
tools services idle status                    # is the task registered?
tools services reap-idle --dry-run            # what it would stop now
tools services reap-idle --idle-hours 6       # stop now what no client used for 6 h
tools services idle uninstall
```

- `--idle-hours` defaults to 24 and must be a positive number (`0.5` works). To change it, run `idle install` again:
  it replaces the task.
- The task runs only while [`tools daemon`](../daemon/README.md) is installed.
- Only detached servers with a port are candidates, meaning the ones started on demand (for example by a click through
  the browser router's `local-services` preset). A launchd job is never stopped: it is installed to stay up.
- A server counts as in use while any client holds a connection to its port. An open browser tab keeps a dev server's
  socket, so a dashboard with an open tab is never stopped.
- A service seen for the first time counts as used now, so it always gets the full idle time. A first `reap-idle` on
  a Mac that never ran one stops nothing.
- Before each stop, `reap-idle` reads the connections again. A server that got a client meanwhile is kept (`a client
  connected, kept`), and its idle time starts again. When that second read fails, it prints `connections unreadable,
  kept`.
- `--dry-run` prints `would stop` and never writes the idle state.

## How it works

### What counts as a service

A service is one of:

- a registered port (`src/utils/ui/dashboards.ts`) whose listener passes that entry's process check;
- a running `com.genesis-tools.*` launchd job: the tools daemon, the MCP gateway, ai-proxy, and any dashboard installed
  with its `install` verb (`~/Library/LaunchAgents/com.genesis-tools.<key>.plist`).

The listening sockets come from a fast socket read, with `lsof` as the fallback. Under load `lsof` alone took 9 s.

The root of a service is the launchd job's process, or else the topmost GenesisTools process above the listener. A stop
signals the root and every process below it. The `UP` column is the root's age.

A process is left out when anything above it is an agent session: a `~/.genesis-tools/bin/gt-cc`, `gt-claude`,
`gt-codex`, `gt-grok`, `gt-cursor` or `gt-task` launcher, or an agent CLI or a wrapper around one. So a dashboard that
an agent started inside its session is not listed, and `restart` and `down` cannot reach it.

### Old code

- The folders checked are `src/<tool>/` for every `.../GenesisTools/src/<tool>/` path in the listener's command line,
  plus `src/utils/`.
- A file counts when a commit since the process start touched it (`git log --since`), or when it is uncommitted
  (untracked files too) with a modification time newer than the start, or when it is deleted and not committed.
- A rebased commit counts as new. That can only call a current service old, never the other way round.
- A row with no start time counts as current.
- The git history read is the checkout that runs `tools services`. `tools` on PATH runs the main checkout, which is the
  one the services run from.

### Restart and stop

- **A launchd job** restarts through launchd, since KeepAlive owns it and a kill would only respawn it. The daemon uses
  `tools daemon restart`. Every other job uses `launchctl kickstart -k gui/<uid>/<label>`, then waits up to 30 s for a
  new process (and its port, when it has one).
- **A detached server** needs a port and a command to start it again. Its own arguments come first, read from its
  command line, so a server started on one folder or port comes back the same (`artifact serve notes --port 3076`).
  The registry's launch command is the fallback, when it is a `tools` command.
- **The stop** sends SIGTERM to the root and its whole process tree, waits up to 10 s for every process to exit and
  the port to close, then sends SIGKILL and waits 3 s more. A signal goes only to a process that still runs the command
  line the inventory read, so a reused pid is left alone. `down` and `reap-idle` use the same stop.
- **When the stop fails**, the restart returns that failure and starts nothing, so no second copy runs.
- **The start** runs detached in the server's own working folder, so relative arguments resolve there, and waits up to
  30 s for the port.

### The fleet

- `up` starts the API servers together, then the dashboards together. `down` stops the dashboards first, then the API
  servers, one at a time.
- A port that already accepts connections counts as running only when its listener passes the registry entry's process
  check, the same check that decides what `tools services` lists. Any other process on a registered port is a
  collision: `up` reports it as failed and starts nothing, instead of calling it running.
- A missing server starts with its registered launch command. A `tools …` command goes through the shared launcher and
  GenesisTools.app, as it does on a terminal. `up` then waits up to 20 s for the port on `127.0.0.1` or `::1`.
- `up` and `down` know a server only by its registry port. When a port variable moves it elsewhere
  ([Configuration](#configuration)), `up` fails that row instead of waiting on the wrong port.
- `down` names a launchd job (`launchd` row) and leaves it running.

The same start code is `tools browser-router ensure <port>`, which the `local-services` preset runs when you click a
`localhost:<port>` link.

### Data, requirements, cost

- `~/.genesis-tools/services/config.json` holds the idle state under `activity`: for each running instance
  (`<id>@<start time>`), the last time a client was connected. A restarted server gets a new key and a fresh idle
  window.
- A server that `up` starts has no terminal. It writes the shared day log `~/.genesis-tools/logs/<YYYY-MM-DD>.log`,
  which the timeout message names.
- When `reap-idle` stops a server, it posts one macOS notification, "Idle servers stopped". The daemon task itself
  notifies only when it fails.
- The idle task (`services-idle-reap`) has no retries and a 60 s timeout. The reap takes about 0.2 s, but the task
  starts on the same 15-minute slots as other daemon tasks. With a 10 s bound, the process start alone waited a median
  1.9 s and up to 19.8 s, and 4 of 67 runs timed out (2026-10-28). Without a bound, a stalled run held its slot for up
  to 20 minutes.
- It is built for macOS: it needs `launchctl` and `git`. It makes no network calls beyond port checks on localhost, and
  it costs nothing.

The library is `src/utils/services/`: `inventory.ts` (what runs), `stale.ts` (old code), `lifecycle.ts` (stop and
restart), `fleet.ts` (`up` and `down`), `idle.ts` (the idle state), and `ensure.ts` (start a registered port, used by
`tools browser-router ensure`).

### Registry keys

The keys `up` and `down` take, read from `src/utils/ui/dashboards.ts` on 2026-11-09. That file is the source of truth.

| Key | Port | Group | Bare `up` |
|---|---|---|---|
| `youtube-server` | 9886 | API | yes |
| `monitor-server` | 9878 | API | yes |
| `telegram-webhook` | 8319 | API | yes |
| `ai-proxy` | 8317 | API | only named |
| `mcp-gateway` | 8318 | API | only named |
| `youtube-extension` | 9877 | API | only named |
| `mcp-oauth-callback` | 8320 | API | never (no launch) |
| `artifact-library` | 3096 | dashboard | yes |
| `jev` | 3088 | dashboard | yes |
| `claude-history` | 3069 | dashboard | yes |
| `personal-dashboard` | 3000 | dashboard | yes |
| `dev-dashboard` | 3042 | dashboard | yes |
| `clarity` | 3071 | dashboard | yes |
| `reas` | 3072 | dashboard | yes |
| `shops` | 3073 | dashboard | yes |
| `youtube` | 3074 | dashboard | yes |
| `spotify` | 3075 | dashboard | yes |
| `monitor` | 3077 | dashboard | yes |
| `debugging-master` | 7243 | dashboard | yes |
| `artifact` | 3076 | dashboard | only named |
| `dev-dashboard-cloud` | 7251 | dashboard | only named |

## Configuration

There is no config file to edit. The idle hours live in the daemon task (`idle install --idle-hours`).

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_HOME` | Moves the `~/.genesis-tools` root, idle state included |
| `YOUTUBE_UI_PORT` | Moves `youtube`; `up` then fails it |
| `SPOTIFY_UI_PORT` | Moves `spotify`; `up` then fails it |
| `DEV_DASHBOARD_PUBLIC_PORT` | Moves `dev-dashboard`; `up` then fails it |
| `DD_CLOUD_PORT` | Moves `dev-dashboard-cloud`; `up` then fails it |

## For agents

- `tools services list --json` prints a JSON array, one object per service: `id`, `name`, `port` (or null), `pid`
  (the listener, or the launchd job's own process when it has no port), `rootPid`, `pids`, `commands` (pid to command
  line), `cwd`, `startedAt` (epoch ms, or null),
  `managed` (`launchd` or `detached`), `label`, `launch` (the registry start command), `command`, `relaunch` (the
  `tools` arguments that start it again, or null) and `stale` (the changed repo paths; empty means current).
- `restart` never prompts when you name ids or pass `--stale` or `--all`. Without a terminal it needs one of them.
- Exit codes:
  - `restart`: 1 when an id is not running, nothing was named without a terminal, the picker was cancelled, or any
    restart failed.
  - `up`, `down`: 1 when a key is unknown or has no launch command, or any row is `failed`.
  - `reap-idle`: 1 when `--idle-hours` is not a positive number or the connections cannot be read. A stop that failed
    is printed and logged, but the exit code stays 0.
  - `idle install`: 1 when `--idle-hours` is not a positive number.
  - `idle status` and `idle uninstall`: always 0. Read the text (`is registered` or `is not registered`).
  - `Nothing to restart.` (`restart --stale` with nothing stale) and `Nothing to do.` (`up` or `down` with an empty
    selection) exit 0.
- There is no MCP tool and no plugin skill for this tool.

## Troubleshooting

- **`up` says `port N is held by a process that is not <name>`.** Another process listens on the registered port.
  Find it with `lsof -nP -iTCP:N -sTCP:LISTEN`, stop it, and run `up` again.
- **`up` says `<VARIABLE> moves it to port N`.** A port variable moves the server off its registry port. Unset the
  variable, or start that server yourself.
- **`up` says `did not listen on N within 20000ms`.** The server started but never opened its port. Read the day log
  that the message names.
- **`down` says `not running`, or `restart <id>` says `Not running`, but the port answers.** An agent session started
  that server, or its listener fails the registry check. `tools services` never touches either. Stop it from the
  session that started it.
- **`restart` says `no command to start it again`.** The detached service has no port, or neither its command line nor
  its registry entry names a `tools` command. Start it by hand.
- **`restart` says `did not come back within 30 s`.** launchd did not start the job again. Read
  `launchctl print gui/<uid>/<label>` (the message prints the exact command).
- **`restart` says `did not listen on N within 30 s after tools …`.** The detached server was stopped but did not start
  again. Run that `tools` command by hand to see its error.
- **A stop says `still answers after SIGKILL`.** A process that the stop did not signal still holds the port: one
  outside the service's tree, or one whose command line changed since the inventory read it. Find it with `lsof`, as
  above.
- **`reap-idle` says `lsof could not list connections`.** The connection list could not be read. Nothing stopped and
  the idle times stay as they were; the next run tries again.
- **A service shows old code right after a rebase.** A rebased commit counts as new. Restart it once.

## Related

- [daemon](../daemon/README.md): runs the idle task; `tools daemon restart` is the daemon's own restart.
- [update](../update/README.md): offers `restart --stale` after it pulls.
- [browser-router](../browser-router/README.md): the `local-services` preset and `ensure <port>` start a registered
  server on a click.
- [dashboards](../dashboards/README.md): `up` and `down` over a fixed list of eight servers (seven dashboards and the YouTube API server).
- [artifact](../artifact/README.md), [ai-proxy](../ai-proxy/README.md), [mcp-manager](../mcp-manager/README.md):
  servers outside the default fleet.
- [dev-dashboard](../dev-dashboard/README.md): one of the registered servers.
