# DevDashboard V2 — "Nice Stuff" Feature Synthesis (converge)

> **What this round is.** V2 ideation, deliberately *un-moonshot*. The v1 synthesis
> (`../SYNTHESIS.md`) chased strategy + marketplaces + verifiable-trust standards — useful, but the
> user said it ran "too ADHD." This pass is the opposite: **grounded, delightful, buildable polish**
> that deepens features that already exist server-side (Pulse, ttyd/terminals, Q&A, Obsidian,
> sessions, Claude-usage, daemon, containers) plus the Apple/HomeKit/automation layer the user
> explicitly asked for. Every kept idea rides a primitive the Agent already produces.
>
> Sources: the 5 v2 frames in this folder (`01-feature-depth`, `02-integrations-automations`,
> `03-speedrunner`, `04-3am-oncall`, `05-ten-year-old`). Score chips = `[N novelty, V viability,
> F fit]` 0–10. **Weighted = V·0.45 + F·0.35 + N·0.20** — viability + fit dominate on purpose;
> novelty is the tiebreaker, not the driver. This is the "ship it" weighting, not the "wow" weighting.

---

## 0. The one reframe

The 5 frames independently converged on a single shape:

> **DevDashboard already has the signals and the control rails — V2 is the *last mile* that turns
> raw feeds into glanceable surfaces, one-tap actions, and ambient awareness.** Three repeating
> verbs: **glance** (widgets / Live Activity / HomeKit light / Watch), **act in one tap** (macros /
> batch / runbooks / approve-from-lock-screen), and **route to the one thing that needs me** (command
> palette / triage inbox / incident deep-link). Nothing here needs a new backend — it needs UI depth
> on top of `qa-sse`, the Pulse history-db, daemon `RunSummary`, `ContainerInfo`, and the ttyd
> send-keys path.

The automation engine is the spine: most of the HomeKit / Focus / webhook / runbook ideas are *the
same "when <signal> then <action>" feature wearing different costumes*. Build the engine once; the
costumes are sinks.

---

## 1. Clustered by feature area

Score is `[N V F]`; **W** = weighted (V·0.45 + F·0.35 + N·0.20). `★` = shortlist standout.
"Dup" notes where the same idea showed up in multiple frames (signal of consensus, not extra weight).

### Pulse (system metrics)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Process Inspector + per-PID history** (tap a topProcesses row → CPU/mem chart over time, parent/child tree, "new since 1h", web kill/renice/sample, mobile "watch process" push) | feature | [6 7 9] | 7.4 | PIDs are already in the snapshot; only process *history* is missing. The natural follow-up to "CPU at 90%." |
| **"Diff since I fell asleep" timeline** (scrub everything that changed since last-seen: restarts, flaps, CPU/mem delta) | screen | [7 6 8] | 6.9 | Answers the first on-call question off data already in history-db. |
| **Anomaly baselining on history-db** (learn per-hour normal band, alert on envelope-exit, not fixed thresholds) | automation | [7 6 9] | 7.2 | Kills "it's always at 80%" alert fatigue. Feeds the automation engine's "smart" trigger. |
| Pin a Pulse tile to Lock-Screen / Live Activity (long-press chart → pin) | integration | [6 7 8] | 7.1 | Dup of the Glance-stack; merge into widgets/Live-Activity work. |
| Opt-in load **sonification** (ambient hum tracks CPU+thermal+fan, exhale chime on job done) | delight | [8 5 5] | 5.6 | Genuinely novel sense; niche. Park as an experiment. |

### Terminals (ttyd / tmux / cmux)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Keystroke-macro chips** (record a sequence once → labeled chip on MobileKeyBar → one-tap replay into active pane) | automation | [6 8 9] | 7.9 | Reuses the existing send-keys path + MobileKeyBar. The single highest fit-vs-effort terminal win. |
| **Multi-pane terminal grid + scrollback search** (tiling 2×2/1+2/focus, per-pane cwd + last-exit-code title, search across visible scrollbacks; mobile swipe carousel + pinch-overview) | feature | [6 7 8] | 7.1 | The biggest gap vs a desktop tmux setup. Bigger build; web-first. |
| **Broadcast-to-all-panes toggle** (next line/macro fans out to every visible pane, auto-unsets) | feature | [6 7 8] | 7.1 | Restart N worktree dev-servers in one keystroke. Pairs with grid + macros. |
| Touch-not-type gestures (pinch-fold a log region, drag a process row to trash-to-kill with undo) | feature | [7 6 7] | 6.5 | The drag-to-kill is concrete + reversible; fold gestures are polish. |

### Q&A live stream (`qa-sse`)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Agent-Waiting Triage Inbox** (reframe flat feed into a queue surfacing `agent-signal` waiting events as actionable cards; threaded Q&A pairs; read/superseded → unread badge; web 3-col + j/k inline reply; mobile app-badge + Dynamic-Island pill + quick-reply chips) | feature | [7 8 10] | 8.5 | The flagship Q&A depth pick. "Who's blocked on me right now" is the daily job, today buried in chronology. The SSE stream already tags question/answer/agent-signal. |
| **Swipe-left-to-triage** (left swipe a card → copy answer / save to Obsidian / mute agent / jump-to-source) | delight | [5 8 8] | 7.6 | Clears a backlog at scrollbar speed; reuses Obsidian publish path. Folds into the inbox. |
| **Jump-to-next-unread agent-signal** (FAB/hotkey that scroll-snaps to the next blocking event, dims the rest) | feature | [5 8 8] | 7.6 | Cheap, daily. Part of the inbox. |
| Q&A "listening jar" (marbles bob by urgency, flick to answer/dismiss) | delight | [8 5 6] | 6.0 | Charming, but a re-skin of the inbox; build the inbox first, theme later (or never). |

### Obsidian
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Session Journal / one-tap capture** ("Send to daily note" appends timestamped blocks — Q&A answers, Pulse anomalies, terminal selections, finished runs; auto-built linked Dev Log; mobile Share-sheet target + Shortcut) | feature | [6 8 9] | 8.0 | Vault publish plumbing exists; the missing loop is frictionless capture *from* the dashboard *into* notes. High daily use. |
| Vault-as-a-room spatial map (folders = rooms, wikilinks = doorways, recent notes glow) | screen | [8 4 6] | 5.6 | Lovely, expensive, low daily payoff vs the existing tree. Trap-adjacent. |

### Sessions (tmux/cmux board)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Session Board** (every session as a card: window/pane mini-map, live last-line per pane, cwd, attached/idle + idle time; web hover-peek + bulk actions; mobile card list + idle dot + swipe-to-kill) | screen | [6 7 9] | 7.7 | Power users juggle 8+ sessions but can attach to one — the missing orientation layer. cmux poller + tmux hub already expose this. |

### Claude usage
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Usage Analytics screen** (tokens/cost over time by project/model, burn-rate-vs-window gauge, top sessions by spend, forecast "you'll hit the 5h cap in ~40m"; web stacked-area + CSV; mobile today/week card + burn-rate widget) | feature | [6 8 8] | 7.6 | Aggregator already computes totals; the curve + the "don't get rate-limited mid-flow" forecast is the screen. |

### Daemon (runs / logs)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Run Timeline + log-tail with anomaly markers** (status-colored bars, duration + exit-code, sparkline of historical durations so slow/stuck stands out; tap → tail with highlighted error lines; mobile "watch this run" push + Live Activity) | feature | [6 8 9] | 8.0 | Runs data exists as a flat list; "is this run normal or stuck?" needs the historical-duration comparison. |
| **Incident Cockpit deep-link** (one push → pre-assembled triage screen: offending run's last 50 log lines + Pulse sparkline at failure + one-tap into the right tmux session) | screen | [7 7 9] | 7.9 | At 3am you can't navigate a 4-tab app; the push lands you exactly where the fix is. Builds on the timeline + Q&A action wiring. |
| **Per-daemon runbook cards** (named recovery commands → Face-ID-gated buttons on the incident push, each runs in the daemon's tmux/cmux session, results stream inline) | feature | [7 7 8] | 7.4 | Execute a known recovery without typing half-asleep. Reuses ttyd send-keys. This is the automation "run command" action in disguise. |
| Flap-suppression + auto-heal-then-confirm (crash loop → ONE "restarted 4×, watching" notice + Undo) | automation | [7 7 8] | 7.4 | The engine's dedupe/cooldown feature applied to runs. Folds into the automation spine. |

### Containers
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **Container Control Panel** (per-container CPU/mem/net/IO sparklines, state, health, port map, inline start/stop/restart/logs-f, restart-loop detector; web expandable rows + log drawer + "exec a shell" into a ttyd pane; mobile swipe cards + tap-to-restart) | feature | [6 8 9] | 8.0 | Stats already report; the loop is "see it misbehaving → restart / read logs" without a laptop. |
| **Batch-select containers → one action** (multi-select rows, restart/stop/tail-all, undo toast) | feature | [5 8 8] | 7.6 | Recycle a whole compose stack at once. Cheap add to the control panel. |
| Containers-as-boxes-on-a-shelf (size = mem, wobble = CPU, shake to restart) | screen | [8 5 6] | 6.0 | Fun physical encoding; the control panel's sparklines already convey health. Theme, not feature. |

### HomeKit / Automation (the engine + its sinks) — **the requested marquee layer**
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **★ Visual Rule-Builder — "when <signal> then <action>"** (triggers: Pulse threshold-for-duration, agent-waiting by tag/agent/project, run done/failed, container down, burn-rate high; conditions: time/Focus/project; actions: notify, run command, webhook, HomeKit scene, Focus toggle, Live Activity; per-rule fire history + dry-run) | automation | [7 8 10] | 8.6 | The connective tissue the user asked for. Unifies every scattered alert/HomeKit/command/Focus behind one if-this-then-that surface. **Build this first — everything below is a trigger or a sink.** |
| **★ HomeKit ambient dev-status light** (fused machine mood: calm cyan idle, amber thinking/agent-waiting, soft red blocked/build-fail, green-pulse just-shipped; "Deep Work" scene on long runs) | integration | [7 7 10] | 8.3 | The marquee delight. Turns existing build/agent/metric events into a glanceable physical signal. Senior-safe because it's *ambient light, not a mascot*. (Dup across feature-depth, integrations, 3am, 10-yr-old — strongest cross-frame consensus.) |
| HomeKit "agent-needs-input" beacon (pulse a bulb amber on `tag:question`, hold until you approve/deny, then clear) | integration | [7 7 9] | 7.7 | The single highest-value home signal; a *specialization* of the mood light. Ship as a preset rule. |
| Build/run status light green/red/amber (map `RunSummary.exitCode` + container state to bulb color) | integration | [6 8 9] | 7.9 | The classic build lava-lamp; another preset of the mood light. |
| Saved-command "runbooks" as a rule action (rule writes a stored command sequence into a named pane via send-session — "disk<5% → run cleanup") | automation | [6 7 9] | 7.5 | Turns the dashboard from notify-only into act-without-me. Same as the daemon runbook cards; one implementation. |
| Webhook + Slack/Discord/ntfy sink with `{{templating}}` | automation | [5 8 8] | 7.6 | Cheapest "integrate with everything" (Home Assistant / n8n / Zapier / self-host). Just another action. |
| **Rate-limit / quiet-hours / dedupe per rule** | automation | [5 8 9] | 7.9 | The difference between an engine people keep on and one they disable after a noisy night. Unglamorous, non-negotiable for shippability. |
| Escalation ladder + dead-man's switch (unacked critical climbs rungs: louder re-notify → HomeKit wake scene → teammate webhook; auto-cancel on recovery) | automation | [7 6 8] | 6.9 | Powerful for real on-call; complexity risk. Later, after the base engine is trusted. |
| "Is it just me?" correlation card (cross-check wifi/uplink/upstream → label push local-fault vs internet-down) | feature | [7 6 7] | 6.5 | Stops 3am false alarms. Nice, but a refinement of the alert payload — Later. |
| All-clear bedside ambient + silent Live Activity (calm-green nominal, expand only on degradation) | delight | [6 6 8] | 6.7 | The "trust the room, don't check the phone" payoff. A mode of the mood light. |
| One-tap "panic / focus" recipe (chain: HomeKit deep-work scene + mute Q&A + pause noisy daemon + snapshot Pulse) | automation | [6 7 8] | 7.1 | A pre-built rule + a Shortcut. Delightful demo of the engine. |

### Apple ecosystem (glance + voice + wrist)
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **★ The Glance Stack** (one coherent Live Activity + Dynamic Island for the top live state — agent-waiting / build / long-job % / metric — with tap-to-act; composable Home-screen widget gallery; Lock-screen complication; "Glance Designer" web screen to pick each surface's signal) | delight | [6 7 9] | 7.7 | The user named Live Activities, Dynamic Island, widgets specifically. Bundling them as one *composable* system makes them feel designed, not stapled on. (Dup across feature-depth, integrations, speedrunner.) |
| **Agent-session Live Activity with inline approve/deny** (waiting agent's question in the expanded Island + two big App-Intent buttons that write back into the live pane) | screen | [7 7 9] | 7.9 | Collapses "agent blocked → unlock → open app → find pane → answer" into one lock-screen tap. The biggest daily-use agent win. |
| **Long-job / build Live Activity** ("watch this run" → spinner+elapsed compact, last log line + exit code expanded, push final state) | screen | [6 8 9] | 8.0 | Headline glanceable for render/encode/indie-build personas. Dup of daemon "watch this run" — same ActivityKit surface. |
| **App Intents for query + action** ("Hey Siri, is my build green?"; parameterized run-saved-command / approve-latest / restart-container; powers Spotlight + Action button) | integration | [6 7 9] | 7.7 | Makes the app scriptable across Shortcuts (leaving-home, NFC-to-restart, voice-while-driving). Foundation for the inline-approve buttons too. |
| **Multi-size Home + Lock-screen widget set** (lock circular/inline = machine green/red dot + pending-question count; medium home = CPU/mem/disk sparkline + last-run color + container health) | screen | [5 8 9] | 8.0 | "Glance, don't log in" — keeps the app on the first home screen. Part of the Glance Stack. |
| **Focus-filter integration** (`SetFocusFilterIntent`: Sleep → only agent-blocked breaks through, Work → all thresholds on) | integration | [7 7 8] | 7.4 | The OS already knows your context; piggy-back instead of a second DND schedule. Reads as a global condition in the rules engine. |
| Apple Watch complication + minimal app (one Pulse metric ring + pending-question badge; quick-actions to approve/deny or fire a runbook with haptics) | screen | [6 6 8] | 6.7 | The wrist is the lowest-friction "is anything on fire" check. Heavier platform lift → Later. |

### Cross-cutting
| Idea | Tag | [N V F] | W | Notes |
|---|---|---|---|---|
| **★ Command Palette + Search-Everything + Saved Views** (⌘K fuzzy across sessions, processes, Q&A threads, notes, runs, containers, *actions*; results grouped by source; pin pane/card configs as named Saved Views; mobile pull-down search + swipeable view pages + jump-to-view Shortcut) | screen | [6 8 9] | 8.0 | With 8+ feature areas, navigation cost compounds. One search/command surface + saved layouts is the accelerator that ties the app together. (Dup: feature-depth + speedrunner "jump to anything.") |

---

## 2. ★ Shortlist — the ~10 "nice stuff" features to actually build

Ranked by weighted score, with standout power-user + HomeKit/automation picks marked ★.
Effort = rough build size (S/M/L); Surface = where it primarily lives.

| # | Feature | Area | [N V F] | W | Effort | Surface |
|---|---|---|---|---|---|---|
| 1 ★ | **Visual Rule-Builder ("when X then Y")** — the automation spine + dry-run + fire history; ships with rate-limit/quiet-hours/dedupe baked in | Automation | [7 8 10] | **8.6** | L | Web (builder) + Mobile (toggles) |
| 2 ★ | **HomeKit ambient dev-status light** — fused machine-mood color, agent-waiting beacon + build status as presets; "Deep Work" scene on long runs | HomeKit | [7 7 10] | **8.3** | M | Mobile (native HomeKit) + Web (mapping screen) |
| 3 | **Agent-Waiting Triage Inbox** — `qa-sse` reframed into an actionable queue, unread badges, inline reply, quick-reply chips | Q&A | [7 8 10] | **8.5** | M | Both (web 3-col, mobile cards + Island pill) |
| 4 ★ | **Command Palette + Saved Views** — ⌘K search-everything + named layouts + jump-to-view Shortcut | Cross-cutting | [6 8 9] | **8.0** | M | Both |
| 5 | **Run Timeline + log-tail with anomaly markers** — historical-duration sparkline flags stuck runs; tap to tail; "watch this run" | Daemon | [6 8 9] | **8.0** | M | Both |
| 6 | **Container Control Panel** — per-container sparklines + inline start/stop/restart/logs + batch-select + restart-loop detector | Containers | [6 8 9] | **8.0** | M | Both |
| 7 | **The Glance Stack** — composable Live Activity / Dynamic Island / widgets / Lock-screen, designed in a web "Glance Designer"; includes long-job + agent-session inline approve/deny | Apple | [6 7 9] | **7.9** | L | Mobile (surfaces) + Web (designer) |
| 8 | **Session Journal / one-tap capture to Obsidian** — "Send to daily note" + Share-sheet target + auto Dev Log | Obsidian | [6 8 9] | **8.0** | S–M | Both (mobile Share-sheet is the hook) |
| 9 ★ | **Keystroke-macro chips** — record once, one-tap replay into a pane; pairs with broadcast-to-all-panes | Terminals | [6 8 9] | **7.9** | S | Mobile (MobileKeyBar) + Web |
| 10 | **Usage Analytics screen** — tokens/cost curve by project/model + burn-rate forecast ("hit the cap in ~40m") | Claude-usage | [6 8 8] | **7.6** | M | Web (charts) + Mobile (card + widget) |
| 11 | **Session Board** — all tmux/cmux sessions as cards w/ live last-line, idle state, swipe-to-kill | Sessions | [6 7 9] | **7.7** | M | Both |
| 12 | **App Intents + Focus-filter** — Siri/Shortcuts query+action; Focus gates which alerts break through | Apple | [6 7 9] | **7.6** | M | Mobile |

> **Why 12, not 10.** #11 (Session Board) and #12 (App Intents/Focus) just barely cleared the bar and
> are *cheap riders* on shortlisted work (the board reuses the inbox + ttyd; App Intents are the
> foundation the Glance Stack's approve/deny buttons need anyway). Treat #1–#10 as the committed
> shortlist and #11–#12 as the "free with the others" stretch. **Standout ★ picks** (the ones to lead
> the demo): the **Rule-Builder**, the **HomeKit mood light**, the **Command Palette**, and the
> **macro chips** — they're the power-user + ambient-signal story the user asked for.

---

## 3. Now / Next / Later

Sequenced so each horizon unlocks the next. **The automation engine and App Intents are foundations
— they appear early because later items plug into them.**

### NOW — the foundations + the cheapest daily wins
- **★ Visual Rule-Builder (engine core)** with the unglamorous parts first: rate-limit, quiet-hours,
  dedupe, dry-run, fire-history. Ship with 2 sink types (push + webhook) and 3 triggers (Pulse
  threshold, agent-waiting, run done/failed). *Everything else is a trigger or a sink added later.*
- **Agent-Waiting Triage Inbox** — reframe `qa-sse`; unread badges + swipe-to-triage + jump-to-next.
  Highest fit, ships without any new platform API.
- **★ Keystroke-macro chips** (S) — fastest power-user win on the existing send-keys path.
- **Session Journal one-tap capture** (S–M) — reuses Obsidian publish; the mobile Share-sheet hook.
- **App Intents foundation** — register query + action intents now; the Glance Stack and Watch need
  them, and Siri/Spotlight is free value the day they land.

### NEXT — the glance + ambient layer (the marquee)
- **★ HomeKit ambient dev-status light** — as a *preset rule* on the NOW engine (mood light + the
  agent-waiting beacon + build-status presets). This is the demo headline.
- **The Glance Stack** — Live Activity / Dynamic Island / widgets / Lock-screen, including the
  long-job "watch this run" activity and the agent-session inline approve/deny (uses NOW's App
  Intents). Add the "Glance Designer" web screen.
- **★ Command Palette + Saved Views** — once there are enough screens to be worth searching.
- **Run Timeline + Incident Cockpit deep-link** — timeline first, then the one-push triage screen
  (uses the rule engine to fire the deep-link push).
- **Container Control Panel + batch actions** — sparklines + inline controls.
- **Usage Analytics screen + burn-rate forecast.**
- **Focus-filter integration** — a global condition in the engine.
- **Runbook cards** — the engine's "run command" action surfaced as Face-ID-gated lock-screen buttons.

### LATER — depth + extra surfaces
- **Process Inspector + per-PID history** (needs new process-history capture in the Pulse db).
- **Multi-pane terminal grid + scrollback search** + broadcast-to-all-panes (bigger build, web-first).
- **Session Board** (orientation layer; nice once sessions are numerous).
- **Apple Watch app + complication.**
- **Anomaly baselining** on history-db (smart triggers replacing fixed thresholds).
- **Escalation ladder + dead-man's switch**, **"is it just me?" correlation card** — on-call depth
  once the base engine is trusted.
- **"Diff since I fell asleep" timeline.**

---

## 4. Traps — cute but low daily value, or scope-creep

- **Themed re-skins of real features** (Q&A "listening jar", containers-as-wobbly-boxes,
  vault-as-a-room). *They are presentation layers over the inbox / control-panel / vault-tree, not new
  capability.* Risk: building the theme before the feature. **Rule: ship the functional version
  first; the playful skin is an optional theme, only if it doesn't cost feature time.** The HomeKit
  mood light is the exception — it's ambient *output*, not a re-skin of a screen, and it's exactly
  what the user asked for.
- **Sonification** — genuinely novel, but a niche sense most users disable. Park as an opt-in
  experiment, not a roadmap line.
- **Escalation ladder / dead-man's switch** — powerful but a complexity magnet (state machine,
  failure modes, "why did it page my teammate at 3am"). Don't build until the *base* engine has been
  trusted in production for a while. Later, not Next.
- **Multi-pane terminal grid on mobile** — desktop tmux is the reference; a phone-sized 2×2 of live
  WebView terminals is heavy and cramped. Web-first; mobile gets the swipe-carousel, not the grid.
  Risk of over-investing in the hardest surface.
- **Watch app pulled too early** — real value, but a separate platform target (WatchKit) that
  multiplies QA surface. Gate behind the App Intents + Glance Stack landing first (it reuses both).
- **Engine scope-creep** — the rule-builder can balloon into a visual programming language. **Hard
  cap v1 at: single trigger → conditions → ≤3 actions, no branching, no loops.** Branching is the
  trap that turns a feature into a platform.

---

## 5. Web app vs. mobile app — where each lives

The pattern across the shortlist: **the web app is the *authoring + analysis* surface (big screens,
keyboard, multi-pane, charts); the mobile app is the *glance + one-tap-act* surface (widgets, Live
Activity, HomeKit, Share-sheet, Siri).** Most features want both, with different weight.

- **Web-led** (author/analyze; mobile gets a read-only or compact echo): Rule-Builder *builder* canvas
  + automation log, Command Palette + multi-pane Saved-View grid, Run Timeline (Gantt) + side log
  pane, Container Control Panel (expandable rows + log drawer + exec-shell), Usage Analytics (stacked
  area + CSV), Multi-pane terminal grid, Glance *Designer*, Process Inspector split-view.
- **Mobile-led** (the surfaces simply don't exist on web): everything Apple — Live Activity / Dynamic
  Island / WidgetKit / Lock-screen complications / App Intents / Focus filter / Watch — plus native
  **HomeKit** pairing, the **Share-sheet** capture target, **macro chips** on the MobileKeyBar, and
  swipe/haptic triage gestures.
- **Genuine parity (both first-class)**: Agent-Waiting Triage Inbox, Session Board, Session Journal
  capture, Keystroke macros (web records, mobile fires), the Incident Cockpit deep-link target.
- **Engine is shared, surfaces differ**: the rules *run* server-side in the Agent regardless of
  client; the web *authors* them richly, the mobile app *toggles* presets and exports a rule as a
  Shortcut.

---

## 6. Fold into `PRODUCT-ROADMAP.md`

These are **feature-depth** items, not new strategy — they slot under the existing roadmap, mostly
extending lines already there. Suggested merge when ready:

- **NEXT bucket** already has *"Push alerts engine (one engine, many triggers)"* and *"Home-screen
  widgets + Live Activities + Lock-screen actions."* → **Promote the Rule-Builder, HomeKit mood
  light, and Glance Stack to be the concrete shape of those two lines** (they're the same idea, now
  specified). Add the **Agent-Waiting Triage Inbox** as the UI for the existing *"Agent-session
  monitoring + remote approve/deny"* ★ line, and **Command Palette + Saved Views** alongside the
  existing *"Command palette + saved snippets/macros"* line (extend it to search-everything + saved
  layouts).
- **New NEXT lines to add**: Run Timeline + Incident Cockpit deep-link; Container Control Panel +
  batch actions; Usage Analytics + burn-rate forecast; Session Journal one-tap capture; Focus-filter
  integration; keystroke-macro chips (under the terminal write path).
- **LATER bucket** already lists *Watch app*, *Siri Shortcuts / App Intents*. → Add: Process Inspector
  + per-PID history; Multi-pane terminal grid + scrollback search; Session Board; anomaly baselining;
  escalation ladder. Keep App Intents *foundation* moved up to NOW (the Glance Stack depends on it).
- **Monetization fit**: the Rule-Builder, HomeKit, widgets/Live-Activity, Watch, and Siri all already
  sit in the **Pro** tier copy ("widgets, Live Activities, Watch app, Siri Shortcuts, command
  palette/macros"). No pricing change needed — V2 just *fills in* what Pro contains.
- **Do not** add the traps (sonification, escalation ladder, themed re-skins, mobile terminal grid)
  to the roadmap as committed lines — note them in an "explored / parked" appendix if anywhere.

> **One-line for the roadmap diff:** *V2 is the last-mile polish pass — it specifies the alert engine
> as a visual Rule-Builder, gives it a HomeKit ambient light + a Glance Stack as its flagship sinks,
> reframes `qa-sse` into a triage inbox, and adds the daily power-user screens (command palette, run
> timeline, container panel, usage analytics, session journal). All ride existing primitives; none
> change the trust model or pricing.*
