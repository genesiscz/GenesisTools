# tools monitor

Watch anything that can be up or down, and hear about it the way you want. Websites, status pages, RSS feeds, TCP
ports, DNS names, TLS certificates, JSON APIs, shell commands and AI accounts each become a watcher. One SQLite
database holds them, one background server checks them on a schedule, and a CLI and a live dashboard drive both.
Use it to learn that a site, a provider or a certificate went bad before your users tell you.

## Quick start

```bash
tools monitor add https://example.com --degraded-ms 1500   # watch a site; the first check runs at once
tools monitor add --preset claude-api status.claude.com    # one-click watcher from the preset list
tools monitor server up                                    # scheduler + API on http://127.0.0.1:9878
tools monitor server install                               # same server as a launchd agent: survives reboot
tools monitor status                                       # server, dashboard, counts, open incidents, what is due
tools monitor ui up                                        # dashboard on http://127.0.0.1:3077
```

Without the server nothing runs on a schedule. The CLI reads and writes the database directly, so every command
except `watch` works with the server stopped.

`tools monitor` alone opens an interactive menu in a terminal: status, list, show, the add wizard, run every check,
the notification library, open the dashboard. Without a terminal it prints the `--help` command instead.

## Commands

`tools monitor <command> --help` lists every flag. These commands take `--json`: `add`, `edit`, `list`, `show`,
`history`, `uptime`, `status`, `check`, `run`, `items`, `incidents`, `presets`, `import`, `doctor`, every `targets`
command except `rm` and `test`, and every `notify` command. `export` always prints JSON.

### Watchers

```bash
tools monitor add <target> [--name] [--kind] [--preset id] [--interval 60] [--timeout 10000] \
    [--targets 1,2] [--mute 2h] [--paused] [--no-notify] [--no-deliver]   # plus the kind flags below
tools monitor add                    # no target in a terminal: guided wizard (preset, kind, target, thresholds)
tools monitor edit 3 --interval 300 --targets 1,2 --expect-status 401 --components "Claude API"
tools monitor edit 3 --targets ""    # empty list: back to the default channels
tools monitor list                   # alias ls: id, status, name, kind, target, every, latency, checked, notify, detail
tools monitor show 3                 # status, uptime 24h/7d/30d, config, targets, last 5 checks
tools monitor history 3 --since 1d --limit 50    # --limit 1 to 500, default 30
tools monitor uptime                 # 24h / 7d / 30d per watcher
tools monitor items 8 --limit 20     # the items a feed (or command --items) watcher has seen, and if they were sent
tools monitor incidents --open       # open first; --limit, default 50
tools monitor presets                # the one-click watchers
tools monitor mute 3 --for 2h        # checks continue, nothing is announced; default 1h
tools monitor unmute 3               # lift a mute early
tools monitor disable 3              # pause the checks themselves (history stays)
tools monitor enable 3               # resume them
tools monitor rm 3                   # alias remove: delete the watcher and its history
```

`add` saves the watcher and runs its first check at once, recorded like a scheduled one. `edit` needs at least one
flag, and a kind flag merges into the stored config. A duration (`--mute`, `mute --for`, `history --since`) is a
number and a unit (`30s`, `30m`, `2h`, `1d`) or a compound (`1h30m`). A bare number is minutes. Anything else, or
zero, is refused.

`edit` takes the same flags as `add` except `--kind`, `--preset` and `--paused`, plus `--deliver` / `--no-deliver`
and `--notify` / `--no-notify`. The kind flags:

| Flag | Kind | Meaning |
|---|---|---|
| `--expect-status <code>` | website, json | the status that counts as up (default: any below 400) |
| `--expect-body <text>` | website | the body must contain this text |
| `--degraded-ms <ms>` | most | slower than this is degraded (see below) |
| `--components <names>` | statuspage | comma list of component names to watch |
| `--item-filter <words>` | rss, command | only items whose title or summary has one of these words |
| `--items` | command | stdout is JSON lines of items |
| `--no-deliver` | rss, command | record new items, send nothing |
| `--expect-ip <address>` | dns | this address must be among the answers |
| `--json-path <path>` | json | dot path into the document: `status.indicator`, `items[0].id` |
| `--expect <value>` | json | the value at the path must equal this, as text |
| `--warn-days <n>` | tls | degraded below this many days left (default 14) |
| `--min-days <n>` | tls | down below this many days left (default 0) |

The presets (`tools monitor presets`):

| Id | Kind | Watches |
|---|---|---|
| `claude-status` | statuspage | all of status.claude.com |
| `claude-api` | statuspage | only its "Claude API" component |
| `claude-incidents` | rss | the status.claude.com incident history feed (every 300 s) |
| `openai-status` | statuspage | status.openai.com |
| `xai-status` | statuspage | the Services list on status.x.ai |
| `grok-api` | statuspage | only the API regions on status.x.ai |
| `xai-incidents` | rss | status.x.ai/feed.xml (every 300 s) |
| `github-status` | statuspage | www.githubstatus.com |
| `cloudflare-status` | statuspage | www.cloudflarestatus.com (every 300 s) |
| `cursor-status` | statuspage | status.cursor.com |
| `anthropic-api-http` | website | api.anthropic.com/v1/models; 401 counts as up, degraded above 2000 ms |
| `openai-api-http` | website | api.openai.com/v1/models; 401 counts as up, degraded above 2000 ms |

A preset fills the kind, the name, the interval and its config, and your flags win over it. On the command line you
still pass the target (`--preset claude-api status.claude.com`); the wizard fills it in for you.

### Checking now

```bash
tools monitor check                  # probe every enabled watcher, record nothing, notify nobody
tools monitor check 3                # one watcher; prints "would change up → down" when the status would move
tools monitor check --url example.com:443 --kind tls   # probe an ad-hoc target without saving a watcher
tools monitor run                    # check, record, move incidents, deliver feed items, notify
tools monitor run 3
```

`check` writes nothing to Monitor's own records and notifies nobody, but it runs every probe for real. A `command`
watcher's command runs in full, and a command that keeps its own state can change it during `check`: the
`tools domains watch refresh --items` watcher saves the new domain statuses, so a change that `check` sees is gone
before the next `run` and is never recorded or delivered. While such a watcher is enabled, give `check` the id of
the one watcher you want to probe, and leave the stateful one to `run`. `run` is what the scheduler does. Both exit 2 when a
probed watcher is down, and both run at most 8 checks at the same time.

### Notifications

```bash
tools monitor targets                       # the library (alias: targets list, targets ls)
tools monitor targets add --channel webhook --name "Ops webhook" --url https://hooks.example.com/alerts
tools monitor targets add --channel say --name "Ara (xAI)" --provider xai --voice ara
tools monitor targets add --channel system --name "Loud banner" --sound Glass --ignore-dnd
tools monitor targets add --channel telegram --name "Family" \
    --bot-token "$TELEGRAM_BOT_TOKEN" \
    --chat-id -1001234567890
tools monitor targets add --channel phone --name "Phone" --disabled   # created paused
tools monitor targets edit 2 --disable      # --enable, --name and any channel field
tools monitor targets test 1                # demo through one target, even a paused one
tools monitor targets rm 2                  # its watchers fall back to the defaults
tools monitor notify                        # effective default channels (alias: notify show)
tools monitor notify voices                 # every voice tools say can use now, by provider
tools monitor notify set say --enable --provider macos --voice Samantha
tools monitor notify set webhook --reset    # drop every monitor override for that channel
tools monitor notify set --no-on-degraded   # only down and recovery
tools monitor notify set --no-on-recover    # stay quiet on recovery
tools monitor notify test                   # one test through every enabled default channel
```

Channel fields, the same for `targets add`, `targets edit` and `notify set`:

- `system`: `--sound`, `--title`, `--ignore-dnd` / `--no-ignore-dnd`.
- `say`: `--voice`, `--provider macos|xai|openai`. `notify voices` shows the ids. xAI and OpenAI voices appear only
  once an account or key exists for that provider.
- `telegram`: `--bot-token` and `--chat-id`, both required.
- `webhook`: `--url`, required, http or https. The event is POSTed there.
- `phone`: no fields. It pushes to the phones registered with this Mac (`tools notify phone devices`).

A target that cannot deliver (a webhook without a URL, telegram without a token or chat) is refused, not stored.

### Backup, live view, health

```bash
tools monitor export -o monitor.json        # watchers + targets; holds secrets, keep the file private
tools monitor export                        # the same JSON to stdout
tools monitor import monitor.json           # creates what is missing, keeps the rest
tools monitor watch                         # live events: state changes, new feed items, watcher changes
tools monitor watch --all                   # also every completed check
tools monitor status                        # server, dashboard, counts, open incidents, next 5 due
tools monitor doctor                        # read-only: prints each fix, never applies it
tools monitor open                          # dashboard in the browser, started if needed
```

`watch` prints state changes, new feed items, and a line when a watcher is created, edited or deleted. Without a
terminal, `open` opens nothing: it prints the `tools monitor ui up` command and exits 0.

`import` skips a watcher whose kind and target already exist, and a target whose name already exists. Imported
watchers keep their target subscriptions by target name. It does not run checks; the scheduler finds them due at once.

`doctor` reports the database, the server, launchd, the dashboard, watchers last checked more than 3 intervals ago
(while the server runs), watchers whose recent checks are all `unknown`, watchers that rely on the defaults while no
default channel is on, and library targets no watcher uses. It exits 1 when the server is down, and only without
`--json`. `doctor --json` always exits 0: read `.lines[].level`, where `"err"` marks the server down.

### Server and dashboard

`server` runs the scheduler and the API. `ui` runs the dashboard. Both take the same verbs:

```bash
tools monitor server up [--foreground] [--force]   # background by default; --force frees a held port
tools monitor server down                   # alias stop; --no-force skips the SIGKILL after the grace period
tools monitor server restart
tools monitor server status                 # pid, port, uptime, dependencies, launchd state
tools monitor server logs -n 200            # last lines of the background log
tools monitor server attach -n 50           # tail it; Ctrl+C detaches, the process keeps running
tools monitor server open [--no-qr] [--no-open] [-q key=value]
tools monitor server install                # launchd agent: survives reboot, respawns on crash
tools monitor server uninstall
tools monitor ui up [--no-open]             # same verbs for the dashboard
```

`-i, --interactive` on `server` or `ui` forces the menu of these verbs. In a terminal, the first `up` asks once
whether to install the launchd agent. `up`, `restart` and `install` also list `--port`; see
[Configuration](#configuration) before you use it.

## Watcher kinds

| Kind | Target | Up when |
|---|---|---|
| `website` | URL | the status is below 400; with `--expect-status`, only that status |
| `statuspage` | status page | the page reports no problem |
| `rss` | RSS 2.0 or Atom URL | the feed parses |
| `tcp` | `host:port` | a TCP connect succeeds |
| `dns` | hostname | A or AAAA records resolve |
| `tls` | `host[:port]` | a verified handshake, with enough days left |
| `json` | URL | the value at `--json-path` exists, or equals `--expect` |
| `command` | shell command | it exits 0 |
| `ai-provider` | `acc_…` account id | the provider plugin's health probe passes |

- **website**: GET by default. `--expect-body` must appear in the body. A bare host gets `https://`.
- **statuspage**: reads the page's data, not its HTML: `/api/v2/summary.json` (Atlassian Statuspage, incident.io),
  the page indicator and every component. `none` is up; `minor` and `maintenance` are degraded; `major` and
  `critical` are down. A component in degraded performance, partial outage or maintenance is degraded; a major
  outage is down; a state it does not know is `unknown`, never up. `--components "Claude API"` keeps only the
  components whose name contains one of the comma-separated names (case-insensitive, so `"Claude API"` does not
  match a component named only `API`), and then the page-wide indicator is ignored,
  so an outage elsewhere does not flip the watcher. A filter that matches nothing is `unknown`. status.x.ai has no
  JSON API, so its Services list is read from the page. The dashboard loads the component list so you can tick them.
  The target is cut to the page origin (`https://status.example.com/history` becomes `https://status.example.com`).
- **rss**: every item not seen before is stored and delivered through the watcher's targets. See
  [Feed items](#feed-items).
- **tcp**: the port is required.
- **dns**: `--expect-ip 203.0.113.10` must be among the answers. A scheme or path in the target is dropped.
- **tls**: the port defaults to 443. Fewer than `--warn-days` (14) days left is degraded, fewer than `--min-days` (0)
  is down, and an expired certificate is always down. The detail names the subject, the expiry and the issuer.
- **json**: fetch the document and read `--json-path`. With `--expect ok` the value must equal it as text; without
  it the path only has to exist. An empty path means the whole document. A status below 400 is needed; with
  `--expect-status`, only that status counts as up.
- **command**: runs `sh -c "<target>"`. Exit 0 is up, anything else is down, and a command still running at the
  timeout is killed and down. The last line of stderr (or of stdout when stderr is empty) becomes the detail, so a
  script can explain its own verdict. With `--items`, a passing check's detail is the item count instead, and its
  stdout is JSON lines of items, delivered like feed items:
  `{"guid","title","link"?,"summary"?,"publishedAt"?}` (the schema is `@genesiscz/utils/watch/items`). `guid` is the
  identity: the same change prints the same guid every run. A line without a `guid` and a `title` is skipped.
- **ai-provider**: the target is an account id from `tools ai config account list`. The probe runs with
  `probe: true`, so it reads the credentials without rotating them and never spends a single-use refresh token. A
  missing account, or a provider without a health probe, is `unknown`.

`--degraded-ms` marks a slow answer as degraded for `website`, `json`, `tcp`, `dns`, `command` and `ai-provider`.
It has no effect on `statuspage`, `rss` and `tls`.

When `--kind` is left out, it is guessed from the target: `acc_…` is an AI account; a path ending in `.rss`, `.atom`
or `.xml`, or a `/feed`, `/rss` or `/atom` segment, is a feed; a host that starts with `status.` or ends in
`status.<tld>` (`www.githubstatus.com`) is a status page; everything else is a website. Pass `--kind tcp`, `dns`,
`tls`, `json` or `command` for those.

Size limits: a feed over 5 MB or a JSON body over 2 MB is down and not parsed, a command may print 256 KB, and one
check reads the first 50 entries of a feed.

## Statuses, incidents and notifications

A check ends `up`, `degraded`, `down` or `unknown`.

- `degraded` or `down` opens an incident. Only a real `up` closes it.
- `unknown` means the check could not decide (status page unreachable, account missing, bad target). It never opens
  or closes an incident, so `down`, then `unknown`, then `down` again stays one incident.
- A check that throws is recorded as `unknown` with `check failed: …`, so a broken watcher never spins.
- A watcher that is still mid-check is skipped, never run twice at once.

One incident, one notification. You hear when an incident opens, when an open incident moves between `degraded` and
`down`, and when it closes (recovery, also from `unknown` to `up`). A return to the same outage after an `unknown`
is not announced again.
`down` always notifies; `notify set --no-on-degraded` and `--no-on-recover` turn off the other two.

Nothing is announced for a watcher created with `--no-notify` (or `edit --no-notify`), or while it is muted. A mute
keeps the checks and the incidents going.

Where a notification goes:

- **Library targets** (`tools monitor targets`): named destinations, as many as you like (several webhooks, several
  voices, a loud banner, a Telegram chat, the phone). Subscribe a watcher with `--targets 1,2` or the "Notify via"
  chips in the dashboard's watcher dialog. A watcher with targets notifies only through them. A paused target is
  skipped.
- **Defaults**: a watcher with no targets uses the `monitor` app in the shared notify config (`tools notify config`),
  overridden per channel with `tools monitor notify set …`. Every default channel and every target has a demo button
  on the dashboard's Notifications page, the same as `notify test` and `targets test`.

### Feed items

`rss` watchers and `command --items` watchers carry items.

- The first sync primes the history silently: the items already in the feed are stored, not sent.
- After that, every new item is sent through the watcher's targets (or the defaults) as `<watcher>: <item title>`,
  with the item link to open. `--item-filter outage,API` keeps only items whose title or summary has one of the words.
- `--no-deliver` records items without sending them; `edit 8 --deliver` turns sending back on.
- An item whose send failed is retried on the next check, before the new ones, so a dead webhook loses nothing.
- A muted watcher swallows its items: they are marked as sent and never replayed after the mute.
- Each watcher keeps its last 500 items.

## How it works

- **Data**: `~/.genesis-tools/monitor/monitor.db` (SQLite) holds the tables `watchers`, `checks`, `incidents`,
  `notify_targets`, `watcher_targets` and `feed_items`. Schema changes ride the shared migrations framework. Checks
  older than 30 days are pruned each time the server starts.
- **Notify defaults**: `~/.genesis-tools/notify/config.json`, the shared config of `tools notify`. The global
  channels are under `channels`, the monitor overrides under `apps.monitor.channels`, and `onDegraded` /
  `onRecover` under `apps.monitor.meta` (both default to true).
- **Server**: `tools monitor server` is a Bun HTTP and WebSocket server on `127.0.0.1:9878`. Its scheduler re-reads
  the enabled watchers every second, so a watcher added from the CLI or paused from the dashboard takes effect
  without a restart, and starts the due ones (8 at once) without waiting for slow ones. A watcher is due when its
  interval has passed since its last recorded check. The launchd label is `com.genesis-tools.monitor-server`
  (`~/Library/LaunchAgents/com.genesis-tools.monitor-server.plist`). The background log is
  `~/.genesis-tools/logs/monitor-server.bg.log` and the pid file `~/.genesis-tools/dashboards/monitor-server.pid`.
- **Dashboard**: `tools monitor ui` is a Vite dev server on `127.0.0.1:3077` (Vite, TanStack Router, TanStack
  Query, shadcn on the shared `AppShell`, cyberpunk theme). Its pages are Overview, a watcher's detail, Incidents
  and Notifications. HTTP to `/api/` goes through the Vite proxy to 9878. The WebSocket goes straight to port 9878,
  because Vite 8 never completes a `proxy.ws` upgrade. The header shows "Live" while the event socket is connected
  and "Polling" otherwise (the overview refreshes every 30 s). The server also serves `src/monitor/ui/dist` when a
  built bundle exists. `ui up` in a terminal offers to start the server when it is down; without a terminal it
  warns and starts only the dashboard. Its launchd label is `com.genesis-tools.monitor`.
- **Security**: the server binds to loopback and sends no CORS headers. Browser writes and the WebSocket upgrade
  are accepted only from `http://` loopback origins on the dashboard's or the server's own port. A request whose
  `Host` is not an IP literal or a `localhost` name is refused (the DNS rebinding guard). All three answer 403.
  Secrets never leave the process through the API: a target view carries `botTokenSet`, `urlSet` and `urlHost`
  instead of the token and the URL, and an edit that leaves them blank keeps the stored value. Watcher
  `config.headers` values are shown as `***` in every view and event, and an edit that sends `***` back keeps them.
- **What it calls**: each watcher's target, on its interval. `tools notify` channels deliver the notifications.
  `tools say` speaks the `say` channel. The AI provider plugins answer `ai-provider` watchers.
- **Costs**: monitor itself costs nothing. A `say` target or default with provider `xai` or `openai` calls that
  provider's text-to-speech with your key, which the provider bills. A `command` watcher runs whatever you give it,
  as often as its interval says.

### HTTP API

The dashboard uses these routes on `http://127.0.0.1:9878`; scripts can too. The CLI needs the server only for
`watch`.

```text
GET    /api/v1/healthz   /overview   /presets   /ai-accounts   /say-voices   /incidents
GET    /api/v1/watchers   /watchers/:id   /watchers/:id/checks   /watchers/:id/incidents   /watchers/:id/items
POST   /api/v1/watchers   /watchers/:id/run   /check   /statuspage/components
PATCH  /api/v1/watchers/:id                 DELETE /api/v1/watchers/:id
GET    /api/v1/targets    POST /api/v1/targets   /targets/:id/test
PATCH  /api/v1/targets/:id                  DELETE /api/v1/targets/:id
GET    /api/v1/notifications   PATCH /api/v1/notifications   POST /api/v1/notifications/test
WS     /api/v1/events    hello, pong, watcher:created|updated|deleted|checked|state, feed:items
```

### Code layout

- `lib/monitor.ts` is the one core behind every door: create, update and delete, `runWatcher()` (check, record,
  incident, feed delivery, notify through targets or defaults, events), target CRUD and `testTarget()`.
- `lib/checks/` has one runner per kind (`http`, `statuspage` with the status.x.ai HTML reader, `rss`, `tcp`, `dns`,
  `tls`, `json`, `command`, `ai-provider`), `body.ts` for bounded reads and `run-check.ts` as the dispatcher.
- `lib/notify-targets.ts` sends to one library target, `lib/notify-settings.ts` manages the defaults and
  `lib/say-voices.ts` lists voices through the Synthesizer.
- `lib/scheduler.ts` is the 1 s tick. `lib/server/index.ts` is the API, `lib/server/app.ts` its lifecycle.
- `commands/*` (the CLI, the interactive menu and the add wizard) and the server routes are thin doors over the
  same lib. `ui/` is the dashboard.

## Configuration

There is no monitor config file: watchers and targets live in the database, and the notify defaults in the shared
notify config above.

| Setting | Default | Range |
|---|---|---|
| `--interval` | 60 s | 10 s to 86400 s |
| `--timeout` | 10000 ms | 1000 ms to 120000 ms |
| `--warn-days` / `--min-days` | 14 / 0 | 1 to 3650 / 0 to 3650 |
| `--expect-status` | any below 400 | 100 to 599 |
| `--degraded-ms` | none | 1 ms to 120000 ms |
| `mute --for` | 1h | any positive duration |

Two settings of website and json watchers have no CLI flag: `config.method` (`GET`, `HEAD` or `POST`, default
`GET`) and `config.headers` (for an `Authorization` header). Set them in an import file, or with
`POST /api/v1/watchers` or `PATCH /api/v1/watchers/:id`. A `HEAD` request skips the `--expect-body` test. A json
watcher sends only `GET` or `POST`: any other method sends a `GET`.

Keep the server on port 9878. The server process takes its port only from its own `--port` argument or the `PORT`
environment variable (`PORT=9900 bun run src/monitor/lib/server/index.ts`). The shared `server up --port` flag does
not hand the port on to that process, and `tools monitor watch` and the dashboard proxy always connect to 9878.
The dashboard always runs on 3077 in the same way: `ui up`, `ui restart` and `ui install` list `--port`, but Vite
always starts with `--port 3077 --strictPort`, and the flag only changes the port the lifecycle checks and waits
on. Keep both on their default ports.

## For agents

The CLI is the whole interface. Add checks from a script or an AI session:

```bash
tools monitor add https://api.example.com/health \
    --kind json \
    --json-path status \
    --expect ok \
    --name "Example API" \
    --json
tools monitor add example.com --kind tls --warn-days 30 --targets 1 --json
tools monitor add "pg_isready -h db.local" --kind command --name "Postgres"
tools monitor add "tools domains watch refresh --items" --kind command --items --interval 3600
tools monitor add "tools alza watchdog list --items" --kind command --items --interval 1800
tools monitor check --json                  # nothing recorded; parse .probes[].check.status
tools monitor status --json                 # .server, .ui, .counts, .openIncidents, .nextDue
tools monitor show 3 --json                 # .watcher (uptime24h/7d/30d, recent points) and .targets
tools monitor incidents --open --json       # .incidents
tools monitor doctor --json                 # always exits 0; .lines[].level == "err" means the server is down
```

- No prompt is ever shown without a terminal. `add` without a target prints the exact command to run and exits 1;
  so do a bad `--kind`, `--channel` or `notify set` channel.
- Exit codes: `check` and `run` exit 2 when a watcher is down; `doctor` exits 1 when the server is down, and only
  without `--json`; `watch`
  exits 1 when it cannot reach the server; a validation error (an unknown id, a bad target, a bad duration) exits 1.
- Prefer `check` for a question ("is it up?"). Use `run` only when you mean to record and notify. A `command`
  watcher's command still runs during `check`, with whatever effects it has (see [Checking now](#checking-now)).
- `tools hub watching` lists every Monitor watcher beside the other watches on the Mac, and
  `tools hub watching mute monitor <id>` mutes one.

## Troubleshooting

- **Nothing is checked, or doctor says "last checked … more than 3 intervals ago".** The server is not running, or
  it stopped. Run `tools monitor server up`, and `tools monitor server install` so it survives a reboot. Read
  `tools monitor server logs`.
- **A watcher stays `unknown`.** Run `tools monitor check <id>` and read the detail. Common causes: the status page
  is unreachable, the `acc_…` account no longer exists (`tools ai config account list`), or `--components` matches
  no component (`no component matches "…"`; fix it with `edit --components`).
- **No notification arrives.** Run `tools monitor doctor`. The watcher may rely on the defaults while no default
  channel is on (`tools monitor notify set system --enable`), it may be muted or created with `--no-notify`, its
  targets may be paused, or `--no-on-degraded` / `--no-on-recover` may hide that event. Remember that a status that
  bounces through `unknown` back to the same outage is not announced twice.
- **A new feed sent nothing on its first check.** That is the priming sync. Only items that appear later are sent.
- **The dashboard header says "Polling".** Its WebSocket cannot reach port 9878: the server is down, or it runs on
  another port.
- **`watch` prints "Cannot reach the monitor server".** Start it with `tools monitor server up`.
- **`ui up` from a script left the server down.** Without a terminal the dashboard does not start its server. Run
  `tools monitor server up` first.
- **A browser request answers 403.** Only the dashboard's own loopback origins may write, and only a loopback `Host`
  is answered. Use the CLI, or `curl` without an `Origin` header.
- **`"…" is not a duration (try 30m, 2h, 1d)`.** Write the duration as a number and a unit.

Server and CLI log lines go to `~/.genesis-tools/logs/<date>.log` with a `monitor:` prefix, for example
`monitor: feed items not delivered, will retry on the next check`.

## Related

- [tools notify](../notify/README.md): the shared channels and the defaults (`tools notify config`), and the phone
  push (`tools notify phone`).
- [tools say](../say/README.md): the voices of the `say` channel.
- [tools ai](../ai/README.md): the accounts an `ai-provider` watcher probes.
- [tools domains](../domains/README.md) and [tools alza](../alza/README.md): sources that print item lines for a
  `command --items` watcher.
- [tools hub](../hub/README.md): `tools hub watching` shows and mutes Monitor watchers.
