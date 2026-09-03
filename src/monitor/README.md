# Monitor

Uptime watchers for websites, public status pages, RSS/Atom feeds and your own AI accounts. One SQLite
database, one background server that runs the checks, a CLI, and a live dashboard.

```bash
tools monitor server up          # scheduler + API on http://localhost:9878 (launchd: tools monitor server install)
tools monitor ui up              # dashboard on http://localhost:3077 (starts the server if needed)

tools monitor add https://example.com --degraded-ms 1500
tools monitor add --preset claude-status status.claude.com
tools monitor add --preset claude-api status.claude.com       # only the "Claude API" component
tools monitor add --preset xai-status status.x.ai             # Grok apps + API regions (scraped Services list)
tools monitor add --preset xai-incidents https://status.x.ai/feed.xml   # rss: every incident delivered
tools monitor add acc_claude-main --name "Claude account"     # ai-provider: plugin health probe
tools monitor list
tools monitor check              # run every enabled watcher now (exit 2 if any is down)
tools monitor check --url https://example.com                 # ad-hoc, nothing saved
tools monitor edit 3 --targets 1,2 --interval 120
tools monitor items 8            # rss: items a feed watcher has seen
tools monitor incidents --open
tools monitor presets
```

## Watcher kinds

| Kind | Target | Up / degraded / down |
|---|---|---|
| `website` | any URL | status `< 400` (or `--expect-status`), optional `--expect-body`; latency above `--degraded-ms` is degraded |
| `statuspage` | Statuspage or incident.io page (`status.claude.com`, `status.openai.com`, `githubstatus.com`, …), or `status.x.ai` | reads the page's **data** (`/api/v2/summary.json`: indicator + per-component state; status.x.ai: its server-rendered Services list). `--components "Claude API"` restricts to matching components; the dashboard loads the component list from the page so you tick them |
| `rss` | RSS 2.0 or Atom URL | up when the feed parses; every item not seen before is stored and delivered through the watcher's targets (`--item-filter outage,API` narrows, `--no-deliver` records only). The first sync primes history silently |
| `ai-provider` | an `acc_…` id from `tools ai config account list` | the provider plugin's `health()` probe (`probe: true`, never rotates a refresh token) |

A check that cannot decide (status page unreachable, account missing) records `unknown`. Unknown never opens
or closes an incident; only a real `up` closes one.

## Notifications

Two layers, both visible on the dashboard's Notifications page:

- **Library** (`tools monitor targets`): named destinations, as many as you like: several webhooks, several voices,
  a loud banner, a Telegram chat. Each has a demo button. Assign them per watcher (`--targets 1,2` or the
  "Notify via" chips in the dialog). State changes and new feed items go only to those targets.
- **Defaults**: watchers with no targets use the monitor app's channels of the shared notify config
  (`tools notify config`), overridable per channel with `tools monitor notify set …`. Every default box has its own
  demo button too.

```bash
tools monitor targets add --channel webhook --name "Slack ops" --url https://hooks.slack.com/…
tools monitor targets add --channel say --name "Ara (xAI)" --provider xai --voice ara
tools monitor targets add --channel system --name "Loud banner" --sound Glass --ignore-dnd
tools monitor targets test 1
tools monitor notify voices                 # every voice tools say can use, grouped by provider
tools monitor notify set say --enable --provider macos --voice Samantha
tools monitor notify set --no-on-degraded   # only down + recovery
tools monitor notify test
```

## Layout

- `lib/monitor.ts` is the one core: create/update/delete, `runWatcher()` (check, record, incident, feed delivery,
  notify through targets or defaults, events), target CRUD, `testTarget()`.
- `lib/checks/` has one runner per kind (`http`, `statuspage` incl. the status.x.ai HTML reader, `rss`,
  `ai-provider`) and `run-check.ts` as the dispatcher.
- `lib/notify-targets.ts` dispatches one event to one library target; `lib/notify-settings.ts` manages the defaults;
  `lib/say-voices.ts` lists voices via the Synthesizer.
- `lib/scheduler.ts` re-reads enabled watchers every second and runs the due ones (CLI checks also advance `last_checked_at`).
- `lib/server/index.ts` is the Bun HTTP + WebSocket API (`/api/v1/*`, events on `/api/v1/events`); it also serves `ui/dist` when built.
- `commands/*` (CLI) and the server routes are thin doors over the same lib.
- `ui/` is Vite + TanStack Router + TanStack Query + shadcn on the shared `AppShell`. In dev the WebSocket goes
  straight to port 9878 (Vite 8 does not complete `proxy.ws` upgrades); HTTP goes through the Vite proxy.

Data: `~/.genesis-tools/monitor/monitor.db` (watchers, checks, incidents, notify_targets, watcher_targets,
feed_items). Checks older than 30 days are pruned on server start; feeds keep their last 500 items.
