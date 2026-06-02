# Speedrunner

Frame-perfect power-user fast paths: macros, one-tap recipes, batched actions, "jump to anything," and abusive-but-legal skips through Pulse / terminals / Q&A / sessions / containers.

## Terminals (ttyd / tmux)

- **Keystroke-macro chips you record once and fire into a pane** — long-press a session to capture a sequence (e.g. `npm run dev`, `Ctrl-C`, `↑ Enter`), save it as a labeled chip on the MobileKeyBar, then one-tap replays it into the active ttyd pane; tag: `automation` — turns the 8-keystroke "kill, rebuild, re-run last" ritual into a single thumb tap.
- **Broadcast-to-all-panes toggle** — flip a "fan-out" switch in the cmux layout tree so the next typed line (or fired macro) lands in every visible pane at once, then auto-unsets after send; tag: `feature` — restart 4 worktree dev-servers in one keystroke instead of tabbing through each.

## Q&A live stream

- **Swipe-left-to-triage on a Q&A event** — a left swipe on any feed card reveals one-tap rails: copy answer, save to Obsidian, mute this agent, jump-to-source — no dialog, no menu, fully thumb-reachable; tag: `delight` — clear a backlog of agent signals at scrollbar speed.
- **"Jump to next unread agent-signal" hotkey/FAB** — a single repeatable control that scroll-snaps to the next event needing your input and dims everything else, so you fly the feed top-to-bottom answering only what's blocking; tag: `feature` — skip the noise, land exactly on the cards that gate an agent.

## Cross-cutting (jump + recipes)

- **Type-ahead "jump to anything" bar** — fuzzy-match across tmux sessions, containers, Obsidian notes, daemon runs, and routes in one input; `Enter` teleports you straight into that pane/log/note; tag: `screen` — reach any object in two keystrokes instead of route-hopping through 9 tabs.
- **One-tap "panic / focus" recipe button** — a home-screen pinned macro that fires a chain: set HomeKit "deep work" scene, mute Q&A sounds, pause the noisiest daemon, and snapshot current Pulse; tag: `automation` — collapse the whole "I'm going heads-down" setup into one press.

## Containers

- **Batch-select containers, then one action for all** — tap to multi-select rows on the containers screen and apply restart / stop / tail-logs to the whole selection at once, with an undo toast; tag: `feature` — recycle a whole compose stack without poking each container individually.

## Pulse

- **Pin-and-park live metric tiles to a Lock-Screen / Dynamic Island glance** — long-press any Pulse chart to pin it as a Live Activity so CPU/build-temp stays one glance away without unlocking or opening the app; tag: `integration` — watch a long build peg the cores from the Lock Screen, zero taps.
