# tools port

`tools port` shows which process holds a local port, lists the dev servers that are listening, watches ports open
and close, and ends the processes you pick. It replaces `lsof -i :3000 | grep LISTEN | awk ... | xargs kill` for
anyone who runs local dev servers. It runs on macOS, Linux and Windows (Git Bash).

## Quick start

```bash
tools port                      # dev servers that listen on a TCP port, one row per port
tools port 3000                 # who holds port 3000; in a terminal it then offers to kill
tools port 3000 --kill --yes    # end every process on port 3000 without a prompt
tools port ps                   # dev processes by CPU, with the ports each one listens on
tools port watch                # print a line each time a port opens or closes
tools port clean                # find dev servers whose parent died, confirm, end them
```

## Commands

Every command takes `-v, --verbose` (debug logging), `--readme` (print this file) and `-h, --help`.

### `tools port [port]`: list the listeners, or inspect one port

| Argument or flag | What it does                                                     |
|------------------|------------------------------------------------------------------|
| `[port]`         | 1 to 65535. Leave it out to list the listening TCP ports.        |
| `-a, --all`      | List view only: add system services.                             |
| `-k, --kill`     | With a port: target every PID, no picker.                        |
| `-y, --yes`      | Skip the confirmation prompt.                                    |
| `-j, --json`     | Print a JSON array instead of the table. It never kills.         |

**Without a port**, the tool lists the TCP ports in the LISTEN state, filtered to dev processes (see
[What counts as a dev process](#what-counts-as-a-dev-process)). The columns are PORT, PROCESS, PID, PROJECT,
FRAMEWORK, UPTIME and STATUS. A port that several processes hold shows once, with the lowest PID. One process that
listens on several ports shows once per port.

**With a port**, the tool lists every TCP and UDP socket whose local or remote end uses that port number, one row per
PID (a PID's LISTEN socket wins over its other states). The columns are PID, PROCESS, USER, STATE, PROJECT, FRAMEWORK,
UPTIME and STATUS. A Location block for the first row follows: the project directory, the command line, the start
time, the resident memory and the git branch of that directory. `--all` changes nothing here: the port view never
filters.

What happens next depends on the flags and on the terminal:

- **In a terminal, without `--kill`:** a multiselect offers "All matching PIDs", then "All listeners" (LISTEN only)
  and "All connections" (clients only) when the port has both kinds, then one entry per PID. A confirmation follows
  unless you pass `--yes`.
- **With `--kill`:** every PID on the port is the target. The confirmation still comes unless you pass `--yes`.
- **When stdin is not a terminal, without `--kill`:** the tool prints the details and stops. It never prompts.

> **`--kill` also ends the clients.** The port view includes every process connected to that port number, so a
> browser tab on `http://localhost:3000` or a `curl` is on port 3000 as well. To stop only the server, run
> `tools port 3000` in a terminal and pick "All listeners".

### `tools port ps`: dev processes, with their ports

| Flag         | What it does                                       |
|--------------|----------------------------------------------------|
| `-a, --all`  | Include system processes and desktop apps.         |
| `-j, --json` | Print a JSON array instead of the table.           |

The columns are PID, PROCESS, CPU%, MEM, PROJECT, FRAMEWORK, UPTIME and WHAT. Rows sort by CPU, highest first. CPU%
is the recent usage on macOS and the average since the process started on Linux and Windows. It is green below 5, yellow from 5 and red from 25. WHAT holds the first three arguments of the command that are not
flags (a path shows as its file name), then the ports the process listens on, for example `server.js [:3000, :3001]`,
cut to 34 characters. The list includes the processes of other users. PIDs 0 and 1 and the tool itself are left out.

### `tools port clean`: end orphaned and zombie listeners

| Flag        | What it does                     |
|-------------|----------------------------------|
| `-y, --yes` | End them without a confirmation. |

`clean` finds the listening TCP ports whose owner is a zombie, or a dev process whose parent is PID 1 (for example a
`bun run dev` left behind when its terminal closed). It prints them (PORT, PID, PROCESS, PROJECT, STATUS), asks once,
ends them, and prints one line per port: a check mark when the process ended, `forced` when it needed SIGKILL, and a
cross with the error when it failed. When stdin is not a terminal and you did not pass `--yes`, it prints the
`tools port clean --yes` command and stops.

> **A server that launchd or systemd starts also has parent PID 1.** `clean` lists it as orphaned when its process is
> on the dev list, for example a `bun` server that runs as a LaunchAgent. Read the preview before you confirm.

### `tools port watch`: print ports as they open and close

| Flag                  | What it does                                               |
|-----------------------|------------------------------------------------------------|
| `-a, --all`           | Include system services and desktop apps.                  |
| `-i, --interval <ms>` | Milliseconds between two scans. Default 2000, minimum 250. |

`watch` scans the listening TCP ports, compares each scan with the one before it, and prints a line per change:

```text
  14:02:11 ▲ OPEN   :5173 ← node [app] Vite
  14:05:40 ▼ CLOSED :5173
```

The first scan prints every port that is already open as `OPEN`. A port that a new PID takes over prints `OPEN` again,
with no `CLOSED` line before it. The loop survives Mac sleep. Press Ctrl+C to stop.

## How it works

**What it reads.** The tool asks the kernel through the shared process layer in `src/utils/process/`: libproc
through `bun:ffi` on macOS, `/proc/net` and the descriptor links in `/proc/<pid>/fd` on Linux, and `netstat -ano`
with one PowerShell CIM query on Windows. On macOS it falls back to `lsof` when libproc is not available. On Linux and Windows a failed read gives no
rows, so an empty list there does not prove that no process holds the port. Each scan is a full new
read, which is why `watch` refuses an interval below 250 ms. Measured: the list of 55 listening ports fell from 282 ms
to 9.5 ms of CPU when it moved to libproc (2026-10-13), and `tools port <port>` fell from 245 ms to 12 ms of cold CPU
when the tool stopped spawning `lsof` (2026-10-14).

**What it can see.** On macOS and Linux the sockets come from your own user's processes only, the same rows a
non-root `lsof` prints. A port that root or another user holds does not show, even with `--all`. `tools port ps`
lists other users' processes (one batched `ps` reads their command line and usage on macOS), but their ports and
their PROJECT stay empty. On Windows the tool reads no working directory, so PROJECT stays empty there.

**What it stores.** The tool keeps no config file, cache or state of its own, and has no environment variable of its own (`NO_COLOR` and `FORCE_COLOR` work as in every tool). The PID picker and
the confirmations are `@clack/prompts` prompts. They run only when stdin is a terminal, except the confirmation that
`--kill` without `--yes` asks for. A
warning about a reused PID goes to the GenesisTools day log, `~/.genesis-tools/logs/<date>.log`. The tool makes no
network call and needs no macOS privacy grant. The port view (not its `--json` form) runs
`git -C <project> rev-parse --abbrev-ref HEAD` once for the branch.

### What counts as a dev process

The list views (`tools port`, `ps`, `watch`) and the orphaned status keep a process when:

- its name is one of `node`, `bun`, `deno`, `npm`, `npx`, `pnpm`, `yarn`, `python`, `python3`, `ruby`, `java`, `go`,
  `php`, `uvicorn`, `gunicorn`, `flask`, `rails`, `tsc`, `tsx`, `vite`, `webpack`, `cargo`, `rustc`, `docker`,
  `docker-proxy` or `com.docker.backend`, or
- its command line contains one of the words `next`, `vite`, `nuxt`, `webpack`, `remix`, `astro`, `flask`, `django`,
  `uvicorn`, `rails` or `cargo`, or the text `manage.py` or `docker`.

A process whose name starts with `spotify`, `raycast`, `tableplus`, `postman`, `linear`, `cursor`, `slack`,
`discord`, `firefox`, `chrome`, `google`, `safari`, `figma`, `notion`, `zoom`, `teams`, `loginwindow`,
`windowserver`, `kernel_task`, `launchd`, `mdworker`, `cfprefsd`, `rapportd` or `systemuiserver` never counts. A
database such as `postgres`, `mysqld` or `redis-server` is not on the list: use `--all` to see it.

### The PROJECT, FRAMEWORK and STATUS columns

- **PROJECT** is the nearest folder at or above the process's working directory, up to 12 levels, that holds
  `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, `pom.xml` or `build.gradle`. Without such a
  folder it is the working directory itself.
- **FRAMEWORK** comes from the command line first (Next.js, Vite, Nuxt, Angular for `ng serve`, Webpack, Remix, Astro,
  Gatsby, Flask, Django, FastAPI for `uvicorn`, Rails, Rust, Docker), then from the runtime name (`node` is Node.js,
  `bun` is Bun, then Python, Ruby, Java, Go). Only when both give nothing does the tool read the project's
  `package.json` dependencies and config files. So a plain `node server.js` shows Node.js, even when the project
  depends on Express. The command test matches plain text, so a path that contains `next` also reads as Next.js.
- **STATUS** is `healthy`, `orphaned` (a dev process whose parent is PID 1), `zombie` (the process state holds `Z`),
  or `unknown` (the tool could not read the process).

### How a kill works

1. Before it sends a signal, the tool compares the PID's current command line with the one it read in the scan. A
   PID that is gone gets no signal and counts as ended. A PID that now runs another command (the kernel gave the
   number to a new process while you answered the prompt) also gets no signal and counts as ended, and the tool logs a
   warning. This check exists since 2026-08-19.
2. It sends SIGTERM to each PID, waits 1 second, checks the identity again, and sends SIGKILL to the ones that are
   still alive. Those show as "force-killed (SIGKILL)", or `forced` in `clean`.
3. A process of another user fails with a permission error, printed for that PID.

On Windows the tool runs `taskkill /PID <pid> /F` at once, with no grace period and no identity check.

## For agents

- `tools port --json`, `tools port <port> --json` and `tools port ps --json` print one JSON array on one line to
  stdout. An empty result prints `[]`. `clean` and `watch` have no JSON output.
- A port row has `port`, `pid`, `processName`, `command`, `user`, `state`, `name` (the socket ends, like
  `127.0.0.1:3000 (LISTEN)`), `fd`, `cwd` (the project root, or null), `projectName`, `framework`, `uptime` (text
  such as `2h 5m`), `startTime` (ISO 8601 or null), `memory` (text such as `45.2 MB`) and `status`. `port` is the local port of the row's socket. In
  `tools port <port> --json` a client row carries its own local port, and the inspected port is the remote end in
  `name` (`127.0.0.1:52344->127.0.0.1:3000 (ESTABLISHED)`), so do not filter rows by `port == 3000`.
- A `ps` row has `pid`, `ppid`, `processName`, `command`, `user`, `cpu` (a number), `memory`, `cwd`, `projectName`,
  `framework`, `uptime`, `startTime`, `description` (the WHAT text without the ports), `status` and `listeningPorts`
  (an array of numbers).
- To kill without a person, pass both flags: `tools port 3000 --kill --yes`. Without `--yes` the tool asks for a
  confirmation. Without a terminal on stdin, `tools port 3000` never prompts, but `--kill` without `--yes` stops at a confirmation
  prompt that nothing can answer. Always pass both flags in a script.
- Exit codes: 1 for an invalid port or interval, 130 after Ctrl+C in `watch`, 0 otherwise. A kill that fails for one
  PID still exits 0, so read the per-PID lines. A cancelled or declined prompt also exits 0.

## Troubleshooting

- **"No matching listening ports found."** The server is not on the dev list (a database, for example): run
  `tools port --all`. If it still does not show, another user or root owns it. Check with
  `sudo lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **"No process found on that port." while the port answers.** Another user or root owns the socket, so the tool
  cannot read it. Use the `sudo lsof` command above.
- **"Invalid port number".** The port must be a whole number from 1 to 65535.
- **"Invalid interval".** `--interval` takes whole milliseconds, 250 or more.
- **A PID fails with a permission error.** The process belongs to another user. End it with `sudo kill <pid>`.
- **`clean` offers to end a server you want to keep.** launchd or systemd started it, so its parent is PID 1. Answer
  no, or run `tools port <port>` and pick the PIDs yourself.

## Related

- [`tools zsh`](../zsh/README.md): `tools zsh enable port` adds a `port` shell function that runs `tools port`. It
  steps aside when another `port` command exists, such as MacPorts.
- [`tools benchmark`](../benchmark/README.md): its built-in `startup` suite times `tools port 99999`, which exits at
  once on the invalid port.
