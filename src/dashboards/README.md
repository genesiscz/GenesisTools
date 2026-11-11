# tools dashboards

`tools dashboards` starts, stops, restarts or checks eight GenesisTools web dashboards with one command. It runs each
dashboard's own lifecycle verb in a fixed order, API servers first, so you do not have to remember which dashboard
serves an API that the others call.

> `tools services up|down` does the same over the whole port registry, so a newly registered dashboard is included
> without editing a list. This tool keeps each dashboard's own lifecycle verbs. The differences are in
> [Compared with tools services](#compared-with-tools-services).

## Quick start

```bash
tools dashboards list                            # what this tool manages, on which port, with which command
tools dashboards status                          # each dashboard's pid, port, uptime and launchd state
tools dashboards up                              # start all eight, API servers first, no browser tabs (see below)
tools dashboards up --open                       # also open a browser tab for the dashboards that allow it
tools dashboards down --except dev-dashboard     # stop everything except one
tools dashboards restart --except shops,youtube  # restart everything except two
```

## Commands

| Command   | What it does                                                   |
|-----------|----------------------------------------------------------------|
| `up`      | Start every dashboard, API servers first                       |
| `down`    | Stop every dashboard, UIs first and API servers last           |
| `restart` | Restart every dashboard, in the same order as `up`             |
| `status`  | Print each dashboard's own status block                        |
| `list`    | Print each managed key, its port and the command that runs it  |

| Flag              | Applies to                        | Meaning                                   |
|-------------------|-----------------------------------|-------------------------------------------|
| `--except <keys>` | `up`, `down`, `restart`, `status` | Comma-separated keys to skip              |
| `--open`          | `up`, `restart`                   | Open browser tabs (default: off)          |

The `down --help` text says "Stop all launchd-managed dashboards", but `down` also stops a dashboard that you started
by hand, because it stops the process on the port.

The tool also takes `-v, --verbose` (verbose logging), `--readme` (print this page) and `-h, --help` (on the tool and
on every command). `list` takes no flags.

## What it manages

The list is `TARGETS` in [`index.ts`](index.ts). Each key runs the command beside it, with the verb you gave
(`up`, `down`, `restart` or `status`) added at the end.

| Key                  | Port | Command                          |
|----------------------|------|----------------------------------|
| `youtube-server`     | 9886 | `tools youtube server`           |
| `youtube`            | 3074 | `tools youtube ui`               |
| `dev-dashboard`      | 3042 | `tools dev-dashboard ui`         |
| `clarity`            | 3071 | `tools clarity ui`               |
| `shops`              | 3073 | `tools shops ui`                 |
| `reas`               | 3072 | `tools internal reas ui`         |
| `claude-history`     | 3069 | `tools claude history dashboard` |
| `personal-dashboard` | 3000 | `tools dashboard`                |

`--except` takes these keys. A key that is not on the list is ignored without an error: it still shows in the
`Skipping:` line, but nothing is skipped. When `--except` names every key, the tool prints
`No dashboards matched (everything excluded?).` and runs nothing.

Each dashboard keeps its own lifecycle commands, for example `tools dev-dashboard ui`, `tools shops ui` and
`tools youtube ui up`. This tool is the fleet-level view, not a replacement for them. The per-dashboard verbs it does
not forward (`attach`, `logs`, `open`, `install`, `uninstall`, and `dev`, which only `dev-dashboard` has) are in each dashboard's README.

### Ordering is deliberate

`up`, `restart` and `status` walk the list from top to bottom. `down` walks it from bottom to top: UIs first, API
servers last. `youtube-server` is the API server on the list, and the YouTube UI calls it.

A UI that starts before its API shows errors until it retries, and an API killed before its UI produces a wall of
failed requests. The order avoids both. It also stops a question: the YouTube UI declares the server as a dependency,
and when the server is down its `up` asks in a terminal whether to start it.

The tool runs one dashboard at a time and waits for each command to exit before it starts the next one.

## How it works

For each key, `tools dashboards` runs this checkout's own `tools` launcher with the key's command and your verb. The
working folder is the repository root, output goes straight to your terminal, and the child gets `BROWSER=none`. Unless
you pass `--open`, `up` and `restart` also add `--no-open`. The exception is `personal-dashboard`: its command declares
`--no-open` on its root program, so the flag never reaches the verb, and it may open a tab anyway.

What happens next is each dashboard's shared lifecycle code (`src/utils/DashboardApp/`):

- **`up`** starts the dashboard in the background and waits until it answers, 30 seconds by default and 90 seconds for
  `dev-dashboard` and `youtube`. When the dashboard has a launchd agent installed, `up` starts the agent instead of a second copy.
- **`down`** unloads the launchd agent when one is installed (`launchctl bootout`; the plist file stays, so the next
  `up` loads it again). Then it sends SIGTERM to the process that listens on the dashboard's port, waits 5 seconds and
  sends SIGKILL. It does this for any process on that port, also one you started by hand in another terminal.
- **`restart`** is `down` and then `up`.
- **`status`** prints the pid, port, uptime, dependencies and launchd state.
- **`--open`** opens a tab only for a UI whose own settings allow it. `dev-dashboard` never opens a tab, and
  `youtube-server` is an API with no page.

`tools dashboards` itself stores nothing, needs no permissions and calls no network service. The files belong to each
dashboard:

| File                                                   | What it holds                       |
|--------------------------------------------------------|-------------------------------------|
| `~/.genesis-tools/dashboards/<key>.pid`                | The running process                 |
| `~/.genesis-tools/dashboards/<key>.config.json`        | The launchd answer, the listen host |
| `~/.genesis-tools/logs/<key>.bg.log`                   | The background log                  |
| `~/Library/LaunchAgents/com.genesis-tools.<key>.plist` | The launchd agent, when installed   |

`<key>` is the dashboard's own key. It is the same as the key in the list above, except for the personal dashboard,
whose files use `dashboard`. `GENESIS_TOOLS_HOME` moves the `~/.genesis-tools` folder.

All checkouts of the repository share these files and the ports. Run the tool from the checkout whose code you want:
`./tools dashboards restart` in a worktree replaces dashboards that another checkout started. When a dashboard has a
launchd agent, `up` and `restart` rewrite its plist to this checkout (command and working folder), so the agent runs
the worktree's code after each reboot or crash. Run them from the main checkout again before you remove a worktree.

### Prompts in a terminal

In a terminal, a dashboard's `up` can stop and ask a question:

- **Install as a launchd agent?** It asks once per dashboard that has no agent yet. The default is no. A "no" is saved
  in `<key>.config.json`, so it does not ask again.
- **Already running.** A dashboard that is already up shows its menu (restart, attach, status, down and more).
- **Port held by another process.** It names the process and offers to kill it when the process is yours.
- **Start the dependency?** Only when its dependency is down.

A same-user process on a dashboard's port counts as the dashboard. `status` shows it as running and records its pid,
after that `up` prints "Already running" and `down` kills it. When a pid file already exists, `up` kills a same-user
port holder without asking, also without a terminal.

Without a terminal (an agent, a script, a pipe) the questions are skipped. A dashboard with no agent starts in the
background without the launchd offer, one that is already running prints the verbs you can use, and one whose port
another process holds does not start.

### Compared with tools services

- `tools services up` reads the whole port registry and starts each server that is not listening with its registered
  launch command. `tools dashboards up` runs a fixed list of eight through each dashboard's own verbs.
- `tools services down` stops the detached servers and names a launchd job without stopping it. `tools dashboards down`
  also unloads the launchd agents.

## Adding a dashboard

Two separate lists matter here.

**The lifecycle list is `TARGETS` in [`index.ts`](index.ts).** It is hardcoded, and `up`, `down`, `restart`, `status`
and `list` all walk it. Each entry pairs a key with the argv that launches the dashboard, for example
`{ key: "shops", args: ["shops", "ui"] }`, because there is no way to derive "how do I start this" from a port number.

❗ **Adding a dashboard to the registry alone does not make this tool manage it.** It will not start, stop or appear in
`list` until it also has a `TARGETS` entry. If you add a dashboard and `tools dashboards status` never mentions it,
that is why. The target command must take the `up`, `down`, `restart` and `status` verbs and the `--no-open` flag,
which every dashboard built on `src/utils/DashboardApp/` has.

**The port and metadata registry is [`src/utils/ui/dashboards.ts`](../utils/ui/dashboards.ts).** It holds browser
dashboards in `DASHBOARDS` and other listeners (HTTP APIs, extensions, proxies) in `WEB_SERVICES`. On 2026-11-09 it had
14 dashboards and 7 other listeners. Ports must be unique across both lists: `findPortConflicts()` finds duplicates,
and a test in `dashboards.test.ts` fails on one. Never hardcode a port for a repository web server; look it up in the
registry.

`list` joins the two lists. It walks `TARGETS` and reads each entry's port from `DASHBOARDS`. So `list` answers "what
does this tool manage, and where does it listen", not "what is in the registry".

## For agents

- The exit code is 0 even when a dashboard fails. A crash of the tool itself exits 1. Read the last line instead:
  `<verb> complete for <n> dashboard(s).` or `<failed>/<total> dashboard <verb> command(s) failed.`, with one
  `<key> <verb> exited <code>` line for each failure.
- The failure count includes only commands that exit non-zero. A dashboard that refused to start because another
  process holds its port can exit 0, so check with `tools dashboards status` after `up`.
- There is no `--json` output and no MCP tool. Run it without a terminal so that no dashboard stops to ask a question.

## Troubleshooting

**A dashboard is missing from `list` or `status`.** It has no `TARGETS` entry. See
[Adding a dashboard](#adding-a-dashboard).

**`list` shows `:?` for `youtube-server`.** `list` reads ports only from `DASHBOARDS`, and the YouTube server is in
`WEB_SERVICES`. Its port is 9886.

**`down` stopped a program that is not a dashboard.** `down` stops whatever listens on each dashboard's port. Port 3000
(the personal dashboard) is a common development port. Skip it with `--except personal-dashboard`. `status` also shows
another program on that port as the dashboard, and `up` can kill it when a pid file exists.

**`up` takes minutes.** The dashboards start one after another, and each one waits until it answers or its timeout
(30 seconds, 90 for `dev-dashboard` and `youtube`) runs out.

**`up` stops and waits.** A dashboard asks a question. See [Prompts in a terminal](#prompts-in-a-terminal).

**`up --open` opened no tab for `dev-dashboard`.** Its own settings turn the browser off. Open it with
`tools dev-dashboard ui open`.

**A dashboard does not start.** Read its log, `~/.genesis-tools/logs/<key>.bg.log`, or run its own command in the
foreground, for example `tools shops ui up --foreground`.

## Related

- [services](../services/README.md): the same `up` and `down` over the whole port registry, plus restarts of servers on
  old code.
- The managed dashboards: [youtube](../youtube/README.md), [dev-dashboard](../dev-dashboard/README.md),
  [clarity](../clarity/README.md), [shops](../shops/README.md), [claude](../claude/README.md) (`history dashboard`),
  [dashboard](../dashboard/README.md).
- [docs/design-system-dashboards.md](../../docs/design-system-dashboards.md): how the dashboards look and which design
  family each one belongs to.
