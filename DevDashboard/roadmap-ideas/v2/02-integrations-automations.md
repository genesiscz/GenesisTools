# V2 Lens — Integrations & Automations (Apple ecosystem + rules engine)

> Turn DevDashboard's existing signals (Pulse / QA live-stream / daemon runs / containers / ttyd / Claude-usage) into **outputs that leave the app**: HomeKit lights & scenes, a "when-this-then-that" automation engine, Siri/Shortcuts, Focus filters, Live Activities + Dynamic Island, an Apple Watch app, and Home/Lock-screen widgets. Every idea names its trigger signal, its action, and the existing primitive that feeds it.

The 12 ideas are grounded in the concrete signal shapes that already exist server-side:
`QaEntry` (`tag: question|action|directive`, `aiAgent`, `agentLabel`, `project`, `branch`) streamed over `qa-sse`; `PulseSnapshot` (`cpuPct`, `memUsedBytes`, `swapUsedBytes`, `batteryPct`, `diskFreeBytes`, `wifiSsid`, `topProcesses`); daemon `RunSummary` (`exitCode`, `duration_ms`, `timedOut`); `ContainerInfo` (`state`, `status`); `UsageSnapshot` (Claude token/cost buckets); and live `TtydSession`/`SplitNode` terminals.

---

## A. Apple HomeKit — drive lights & scenes from dev signals

- **HomeKit "agent-needs-input" beacon** `[integration]` — When a `qa-sse` event arrives with `tag: "question"` (or the existing "agent is waiting" detection), pulse a chosen HomeKit bulb amber and hold it until you tap approve/deny from the phone, then clear it. Rationale: the single highest-value home signal — your desk lamp literally tells you an agent is blocked on you, no phone-glance required. Feeds: `qa-sse` question events → HomeKit Characteristic write via the iOS HomeKit framework (the bridge runs in-app on the phone, so no Mac-side HomeKit dependency).

- **"Dev Mode" HomeKit scene tied to live machine state** `[integration]` — A single user-mapped scene ("Deep Work") that DevDashboard activates when any tracked ttyd/cmux session goes active or a long daemon run starts, and deactivates when everything's idle for N minutes. Rationale: ambient "I'm heads-down / the machine is grinding" is exactly the smart-home trigger people hand-wire today — we drive it off real session + Pulse activity instead of a manual toggle. Feeds: ttyd session activity + daemon `RunResult` start/exit + Pulse `cpuPct`.

- **Build/run status light (green/red/amber traffic signal)** `[integration]` — Map daemon `RunSummary.exitCode` and container `state` to a bulb color: green on `exitCode === 0`, red on non-zero or `timedOut`, amber while running. Rationale: the classic "build-status lava lamp" that CI shops love, but driven by your *actual* daemon runs and container health, with zero extra CI plumbing. Feeds: daemon `RunSummary` (`exitCode`, `timedOut`) + `ContainerInfo.state`.

---

## B. Rules / automation engine — "when <signal> then <action>"

- **Visual rule builder: trigger × condition × action(s)** `[automation]` — A power-user screen (web + mobile) to compose rules from a typed catalog of triggers (QA event by `tag`/`aiAgent`/`project`, Pulse metric crossing a threshold for a duration, daemon run finished with exit code X, container state changed, Claude usage > $ in window) and actions (push, run a saved command in a ttyd pane, hit a webhook, trigger a HomeKit scene, toggle a Focus, post to Slack/Discord). Rationale: this is the spine the other 11 ideas plug into — one engine, many sinks, instead of one-off integrations. Feeds: ALL existing signals as triggers; the action set reuses the ttyd send-keys path the control plane already has.

- **Saved-command actions ("runbooks")** `[automation]` — A rule action that writes a stored command sequence straight into a named ttyd/tmux pane (reusing `send-session`), so "disk < 5% → run my cleanup script" or "container exited → restart it" runs hands-free, with the output visible when you open the app. Rationale: turns the dashboard from notify-only into *act-without-me*, and reuses the interactive terminal you already trust — the killer differentiator vs. read-only monitors. Feeds: Pulse `diskFreeBytes`/`memUsedBytes`, container `state` → ttyd `send-session`.

- **Webhook + Slack/Discord/ntfy sink with templating** `[automation]` — A generic outbound sink: any rule can POST a templated JSON payload (with `{{project}}`, `{{aiAgent}}`, `{{exitCode}}`, `{{metric}}` interpolation) to a webhook, or a formatted message to Slack/Discord/ntfy. Rationale: the cheapest possible "integrate with everything else" — teams already live in Slack, and a raw webhook covers Home Assistant, n8n, Zapier, and self-host setups in one move. Feeds: any trigger; payload built from the `QaEntry` / `RunSummary` / `PulseSnapshot` fields.

- **Rate-limiting, quiet hours & dedupe per rule** `[automation]` — Per-rule cooldown, "only between 09:00–22:00", and collapse-repeats so a flapping CPU metric doesn't fire 40 lights/pushes. Rationale: the difference between an automation engine people keep on and one they disable after a noisy night — this is the unglamorous polish that makes the whole feature shippable for daily use. Feeds: engine-internal (wraps every trigger before it reaches a sink).

---

## C. Apple Shortcuts / Siri intents

- **App Intents for query + action ("Hey Siri, is my build green?")** `[integration]` — Ship `AppIntent`s that expose read queries (latest Pulse snapshot, pending QA questions count, last daemon run status) and parameterized actions (run saved command on machine X, approve the latest agent question, restart container Y). Rationale: makes DevDashboard scriptable from the whole Shortcuts universe — "when I leave home → tell me machine status," voice while driving, NFC-tag-to-restart-container — and App Intents are also what powers Spotlight + the action button. Feeds: Pulse / `qa-sse` / daemon / containers via the same API the app uses; donations make them appear as Siri Suggestions.

---

## D. Focus filters

- **Focus-filter integration: DevDashboard mutes/escalates with your Focus** `[integration]` — A `SetFocusFilterIntent` so that turning on a Focus ("Work", "Sleep") changes DevDashboard's alert behavior: e.g. Sleep → only `tag: "question"` agent-blocked pushes break through (everything else queues), Work → all thresholds active. Rationale: the OS already knows your context; piggy-backing on Focus means users get the right alerts without managing a second do-not-disturb schedule inside the app. Feeds: the rules engine reads the active Focus filter as a global condition gating every sink.

---

## E. Live Activities + Dynamic Island

- **Live Activity for a long daemon run / build (Dynamic Island progress)** `[screen]` — A "watch this run" toggle on any daemon task or long ttyd job starts a Live Activity: compact Dynamic Island shows a spinner + elapsed; expanded shows last log line, exit code on finish, and a tap-to-open-terminal action. Pushes a final state on `exitCode`/`timedOut`. Rationale: this is the headline glanceable surface for the render/encode + indie-build personas already in the roadmap — progress on the lock screen, no app-open. Feeds: daemon `RunResult` start + `LogLine` tail + `RunSummary` exit, pushed via ActivityKit remote updates.

- **Agent-session Live Activity with inline approve/deny** `[screen]` — When an agent enters the waiting state, a Live Activity surfaces the question text in the Dynamic Island expanded view with two big buttons (approve / deny) wired to App Intents that write back into the live pane. Rationale: collapses the "agent blocked → unlock → open app → find pane → answer" chain into one lock-screen tap, the single biggest daily-use win for agent operators. Feeds: `qa-sse` `tag: "question"` → ActivityKit + App Intent button → ttyd `send-session`.

---

## F. Apple Watch — app + complications

- **Watch complication: Pulse + agent-queue at a glance** `[screen]` — A corner/circular complication showing one chosen Pulse metric (CPU% or disk-free) as a ring plus a badge count of pending agent questions, tap-through to a minimal Watch app listing machines and unanswered questions. Rationale: the wrist is the lowest-friction "is anything on fire / does an agent need me" check; complications refresh on a budget that fits Pulse's polling cadence. Feeds: latest `PulseSnapshot` + count of unanswered `qa-sse` `question` events.

- **Watch quick-actions: approve/deny + one-tap saved command** `[automation]` — From the Watch app (and a notification's Watch action), approve/deny the latest agent question or fire a single pre-chosen runbook command, with haptic confirmation. Rationale: pairs with the complication so the wrist isn't read-only — for the "away from desk, agent stuck" moment you can unblock it without pulling out the phone. Feeds: `qa-sse` question → ttyd `send-session`; reuses the same App Intents as Siri/Shortcuts.

---

## G. Home-screen & Lock-screen widgets

- **Multi-size Home + Lock-screen widget set (Pulse dot, build status, agent badge)** `[screen]` — A small Lock-screen circular/inline widget (green/red machine dot + pending-question count), a medium Home-screen widget (CPU/mem/disk sparkline + last daemon run color + container health), and a configurable accessory that picks which machine + which metric. Rationale: "glance, don't log in" is an explicit roadmap goal for indie/solo founders — a widget that's genuinely useful at a glance is what keeps the app on the first home screen. Feeds: latest `PulseSnapshot` series, daemon `RunSummary.exitCode`, `ContainerInfo.state`, and the unanswered-`qa-sse` count, refreshed via WidgetKit timeline + push.

---

## Cross-cutting note

All 12 share one backbone: a small **server-side event router** in `src/dev-dashboard/lib/` that normalizes every existing signal (QA / Pulse / daemon / container / usage) into a single typed `DevEvent` stream, plus a **rules table** the engine evaluates. HomeKit, Live Activities, widgets, the Watch, and Siri are then *sinks/clients* of that one stream — which keeps each integration thin and means a new signal (or a new sink) is additive, not a rewrite.
