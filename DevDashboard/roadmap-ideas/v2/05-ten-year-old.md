# ADHD diverge — 10-year-old frame (v2)

Vantage: a curious kid who's never seen software asks the naive questions adults stopped asking — *why can't I just touch the terminal? why doesn't the computer sound tired when it's working hard? why isn't my folder of notes a place I can walk into?* The vein here is sensory / physical / direct-manipulation / spatial — synesthesia and touch, NOT game loops (that's lens 03's turf). The 3 obvious-for-this-lens answers are banned on purpose: a cartoon mascot for the machine, a CPU-as-speedometer racecar gauge, and confetti-on-green-build.

## HomeKit & ambient signals

1. **Machine-mood room light — your desk lamp *is* the build status**: bind a HomeKit bulb to a single fused "machine feeling" (calm cyan idle → amber thinking-hard → soft red blocked/failed → green-pulse just-shipped), so you feel the build from across the room without unlocking anything. This is the tasteful version of "the computer has a face" — light, not a mascot. `[integration]` — area: `homekit`

2. **"The computer sounds tired" — opt-in load sonification you can leave running**: a quiet ambient hum whose pitch/density tracks CPU+thermal+fan-rpm (a slow warm drone when idle, a tightening higher buzz when it's grinding, a little exhale chime when a long job finishes) so you *hear* the machine working through one AirPod while you do something else. `[delight]` — area: `pulse`

## Automations engine

3. **Plain-kid-sentence rule builder — "WHEN this happens, DO that," with picture blocks**: an automation screen where signals (build fails, agent asks for input, disk almost full, CPU pegged 5 min) and actions (flash the lamp, buzz my phone, run this command, toggle a Focus, fire a webhook) are big draggable cards you snap together like a sentence — no DSL, no YAML, a 10-year-old could wire "when the agent gets stuck, turn my light red AND text me." `[automation]` — area: `automation`

## Apple ecosystem

4. **Lock-screen Live Activity you can *squeeze* — the long job lives in the Dynamic Island**: a running build/agent/long test shows as a Live Activity with a tactile progress ring, and a firm long-press on the island gives you the one urgent control (the agent's yes/no, or abort) with a matching haptic thunk — so the most important machine question reaches your thumb without opening the app. `[integration]` — area: `apple`

## Richer screens

5. **Pinch-to-zoom the log, drag-a-process-to-the-trash to kill it — terminals you touch, not type at**: the mobile shell gets direct-manipulation gestures a kid would expect — pinch a log region to fold/expand it, two-finger-spread to fan out the scrollback, and literally drag a process row into a trash zone to send the kill (with a haptic "snap" + undo) — turning fiddly phone-terminal chores into physical moves. `[feature]` — area: `terminal`

6. **The vault is a *room*, not a list — a spatial Obsidian map you walk through**: render notes as a top-down little world where folders are rooms and wikilinks are doorways/paths, recently-edited notes glow warmer, and tapping a room walks you in — so browsing the vault from the couch feels like exploring a place instead of scrolling a tree. `[screen]` — area: `obsidian`

7. **Shake-a-container, peek-inside-a-box — containers as physical boxes on a shelf**: the Docker screen becomes a shelf of boxes whose size = memory and whose wobble = CPU churn; a healthy box sits still, a thrashing one jitters, an unhealthy one rattles red — tap to open the lid (logs/exec), or shake your phone to "rattle" a hung container into a restart-confirm. `[screen]` — area: `containers`

8. **Q&A "listening jar" — agent signals drop in as tactile marbles you flick to answer**: the live Q&A web screen collects incoming question/agent-signal events as glass marbles in a jar (color by urgency, gently bobbing), and you flick a marble left/right to answer or dismiss with a sound + ripple — making a noisy SSE feed feel like a calm, physical inbox you can clear with your fingers. `[delight]` — area: `qa`
