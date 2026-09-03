# tools monitor

Watch anything that can be up or down, and hear about it the way you want. One SQLite database, one
background server that runs the checks on a schedule, a CLI for scripts and agents, and a live dashboard.

```bash
tools monitor                     # interactive menu (terminal only)
tools monitor server up           # scheduler + API on http://localhost:9878   (reboot-proof: tools monitor server install)
tools monitor ui up               # dashboard on http://localhost:3077          (starts the server if needed)

tools monitor add https://example.com --degraded-ms 1500
tools monitor add --preset claude-api status.claude.com
tools monitor check               # probe everything, record nothing (exit 2 when something is down)
tools monitor status              # server, dashboard, counts, open incidents, what is due next
```

Every command accepts `--json` and works without a terminal. `tools monitor <command> --help` lists the flags.

## Watcher kinds

| Kind | Target | What counts as up / degraded / down |
|---|---|---|
| `website` | URL | status `< 400` (or `--expect-status 401`); `--expect-body "text"` must appear; slower than `--degraded-ms` is degraded |
| `statuspage` | Statuspage / incident.io page, or `status.x.ai` | the page's **data** (`/api/v2/summary.json`: indicator + per-component state; status.x.ai: its Services list). `--components "Claude API"` limits to matching components; the dashboard loads the list so you tick them |
| `rss` | RSS 2.0 / Atom URL | up when the feed parses; every item not seen before is stored and **delivered through the watcher's targets** (`--item-filter outage,API`, `--no-deliver` to record only). The first sync primes history silently |
| `tcp` | `host:port` | a TCP connect succeeds |
| `dns` | hostname | A/AAAA resolve; `--expect-ip 203.0.113.10` must be among the answers |
| `tls` | `host[:port]` | verified handshake; days until the certificate expires (`--warn-days 14` degraded, `--min-days 0` down; expired is always down) |
| `json` | URL | fetch JSON, read `--json-path status.indicator`; with `--expect none` the value must equal it (as text), without it the path only has to exist. `items[0].id` works |
| `command` | shell command | `sh -c`, exit 0 is up, the last output line is the detail; killed at the timeout |
| `ai-provider` | `acc_…` from `tools ai config account list` | the provider plugin's `health()` probe (`probe: true`, never rotates a refresh token) |

`--kind` is guessed when omitted: `acc_…` is an AI account, `.rss`/`.xml`/`/feed` is a feed, `status.*` hosts are status
pages, everything else is a website. Say `--kind tcp|dns|tls|json|command` for those.

A check that cannot decide (status page unreachable, account missing, bad target) records `unknown`. Unknown never
opens or closes an incident; only a real `up` closes one. A check that throws is recorded too (`check failed: …`), so a
broken watcher never spins.

## Watchers

```bash
tools monitor add <target> [--name] [--kind] [--preset id] [--interval 60] [--timeout 10000] [--targets 1,2] [--mute 2h] [--paused] [--no-notify]
tools monitor list                 # table: id, status, name, kind, target, interval, latency, checked, notify, detail
tools monitor show 3               # everything about one watcher: uptime 24h/7d/30d, config, targets, last checks
tools monitor history 3 --since 1d --limit 50
tools monitor uptime               # 24h / 7d / 30d per watcher
tools monitor edit 3 --interval 300 --targets 1,2 --expect-status 401 --components "Claude API"
tools monitor mute 3 --for 2h      # maintenance: checks continue, nothing is announced (feed items are swallowed)
tools monitor unmute 3
tools monitor disable 3 | enable 3 # pause / resume the checks themselves
tools monitor rm 3
tools monitor items 8              # rss: items a feed watcher has seen and whether they were delivered
tools monitor incidents --open
tools monitor presets              # one-click watchers: Claude, OpenAI, xAI/Grok, GitHub, Cloudflare, Cursor, incident feeds
```

`check` versus `run`: `check` probes and prints, records nothing and notifies nobody (safe from a cron or an agent);
`run` records the result, moves incidents, delivers feed items and notifies. `check --url <target>` probes an ad-hoc
target without saving anything.

## Notifications

Two layers, both on the dashboard's Notifications page and in the CLI:

- **Library** (`tools monitor targets`): named destinations, as many as you like: several webhooks, several voices, a
  loud banner, a Telegram chat. Assign them per watcher (`--targets 1,2`, or the "Notify via" chips in the dialog).
  State changes and new feed items go only to those targets. Every target has a demo button (`targets test <id>`).
- **Defaults**: watchers with no targets use the `monitor` app in the shared notify config (`tools notify config`),
  overridable per channel with `tools monitor notify set …`. Every default box has a demo button too.

```bash
tools monitor targets add --channel webhook --name "Slack ops" --url https://hooks.slack.com/…
tools monitor targets add --channel say --name "Ara (xAI)" --provider xai --voice ara
tools monitor targets add --channel system --name "Loud banner" --sound Glass --ignore-dnd
tools monitor targets add --channel telegram --name "Family" --bot-token 123:ABC --chat-id -100…
tools monitor targets edit 2 --disable
tools monitor targets test 1
tools monitor notify                        # effective default channels
tools monitor notify voices                 # every voice tools say can use, grouped by provider (macOS, OpenAI, xAI)
tools monitor notify set say --enable --provider macos --voice Samantha
tools monitor notify set --no-on-degraded   # only down + recovery
tools monitor notify test [--channel say]
```

Secrets (bot tokens, webhook URLs) never leave the process through the API: views carry `botTokenSet` / `urlSet` +
`urlHost` instead, and an edit that leaves them blank keeps the stored value.

## Backup, live view, health

```bash
tools monitor export -o monitor.json        # watchers + targets (holds secrets, keep it private)
tools monitor import monitor.json           # creates what is missing; same kind+target / same target name is kept
tools monitor watch [--all]                 # live events from the server: state changes, feed items (--all: every check)
tools monitor doctor                        # read-only: server, launchd, dashboard, stale watchers, notification wiring
tools monitor open                          # dashboard in the browser
```

## For agents

The CLI is the whole API. To add checks from a script or an AI session:

```bash
tools monitor add https://api.example.com/health --kind json --json-path status --expect ok --name "Example API" --json
tools monitor add example.com --kind tls --warn-days 30 --targets 1 --json
tools monitor check --json                  # every watcher probed, nothing recorded; parse .probes[].check.status
tools monitor status --json                 # .counts, .openIncidents, .nextDue
tools monitor show 3 --json                 # .watcher (with uptime7d/30d, recent points) and .targets
```

Non-interactive rules: no prompts are shown without a TTY; a missing required value prints the exact command to run
(`suggestCommand`) and exits 1; `check` exits 2 when any watcher is down.

## Layout

- `lib/monitor.ts` is the one core: create/update/delete, `runWatcher()` (check, record, incident, feed delivery,
  notify through targets or defaults, events), target CRUD, `testTarget()`. Watchers leave the event stream with
  their `config.headers` masked.
- `lib/checks/` has one runner per kind (`http`, `statuspage` incl. the status.x.ai HTML reader, `rss`, `tcp`, `dns`,
  `tls`, `json`, `command`, `ai-provider`) and `run-check.ts` as the dispatcher.
- `lib/notify-targets.ts` dispatches to one library target; `lib/notify-settings.ts` manages the defaults;
  `lib/say-voices.ts` lists voices via the Synthesizer.
- `lib/scheduler.ts` re-reads enabled watchers every second and launches the due ones without waiting for slow ones.
- `lib/server/index.ts` is the Bun HTTP + WebSocket API (`/api/v1/*`, events on `/api/v1/events`); browser writes and
  the socket upgrade are accepted only from the dashboard's own loopback origins; it also serves `ui/dist` when built.
- `commands/*` (CLI, incl. the interactive menu and add wizard) and the server routes are thin doors over the same lib.
- `ui/` is Vite + TanStack Router + TanStack Query + shadcn on the shared `AppShell`. In dev the WebSocket goes
  straight to port 9878 (Vite 8 does not complete `proxy.ws` upgrades); HTTP goes through the Vite proxy.

Data: `~/.genesis-tools/monitor/monitor.db` (watchers, checks, incidents, notify_targets, watcher_targets,
feed_items; schema changes ride the migrations framework). Checks older than 30 days are pruned on server start;
feeds keep their last 500 items.
