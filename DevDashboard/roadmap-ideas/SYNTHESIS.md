# ADHD roadmap ideation — Phase 2 synthesis (converge)

> Converges the 32 divergent ideas from the 4 isolated frames (`01-competitor`, `02-markets`,
> `03-game-design`, `04-infinite-budget`). Score chips = `[N novelty, V viability, F fit]` 0–10;
> weighted = N·0.35 + V·0.40 + F·0.25. **Deepening (the skill's 3 deepen-agent calls) deferred** per
> the user's "don't have to act on it now" — run later on the ★ picks. This is the opinion + map.

## Brief

The frames independently converged on one reframe: **DevDashboard is not a "view your machine"
app — it's the control + consent + trust plane for autonomous dev/agents.** Monitoring is table
stakes; *steering* (cap, approve, kill, unblock) and *provable trust* are the moat.

## Wide set (clustered by underlying angle)

**A. Steer/control plane (act, don't just watch)** — the strongest cluster.
- Agent action-budget guardrails: pause/kill/throttle a runaway agent from the lock screen `[N8 V8 F10]`
- Never-paywalled panic kill-switch tier `[N6 V9 F9]`
- Boss-fight mode: stalled agent → interrupt with 3 big moves (nudge/pivot/abort) `[N7 V8 F9]`
- Predictive fleet brain: "this agent will loop / this disk fills in 40min / this build OOMs" `[N7 V6 F9]`
- Bio-adaptive gating: block force-push-to-prod when HRV/sleep say you're fried `[N9 V4 F5]` ⚠trap

**B. Verifiable-trust-as-product (turn E2E into artifacts, then a standard).**
- Exportable cryptographic session-attestation receipts for auditors `[N8 V6 F9]`
- Tamper-evident hash-chained "what happened while I slept" replay `[N8 V7 F8]`
- License the E2E transport as a named protocol + audit seal others embed `[N8 V5 F8]`
- Verified-aggregate data co-op: sell provable benchmarks, never raw streams `[N8 V4 F6]`

**C. Human-in-the-loop marketplace (sell expert attention).**
- Steer-session escrow: book a senior to drop into your blocked agent pane, payment held till unblock `[N9 V5 F7]`
- Reverse auction: "who unblocks this agent now" across an on-call pool `[N8 V5 F7]`
- Agent-attention futures: pre-sell "reachable to unblock in next 4h" slots `[N9 V3 F5]`
- Couch co-op pair-debugging: scoped, revocable, E2E-shared control of one machine `[N7 V6 F8]`

**D. Fleet/compute & transport monetization.**
- BYO-relay marketplace w/ per-relay revenue share `[N7 V5 F7]`
- Idle-machine compute lease desk (rent spare cycles to agent jobs) `[N7 V3 F4]` ⚠trap (scope/abuse)
- Agent-compute marketplace brokered through the dashboard `[N6 V3 F4]` ⚠trap

**E. New audiences (beyond agent-devs/vibecoders).**
- Regulated fintech/health/defense on-call (vendor-readable tunnels barred → only we pass review) `[N7 V7 F9]`
- Solo founders / indie homelab running prod from a closet Mac Mini `[N5 V8 F9]`
- On-call SREs: "incident-as-a-level", runbook-ordered encounter `[N6 V7 F8]`
- Operators-of-record for autonomous agents (flight-recorder, insurable/admissible) `[N8 V5 F7]`
- Build/uptime parametric insurance underwritten off live Pulse/CI `[N9 V3 F5]` ⚠trap (regulatory)

**F. Resilience.**
- Offline LAN/BLE mesh fallback when relay/cloud is down `[N7 V6 F8]`

**G. Engagement / ambient / content.**
- Idle-game home-screen widget (machine "colony" state) `[N7 V7 F7]`
- Replay & ghost runs: scrub an agent session like a speedrun VOD, race past-self `[N8 V6 F7]`
- Sell sanitized session replays as a portfolio/teaching format `[N6 V6 F6]`
- Spatial agent-ops room (Vision Pro / AR) `[N7 V3 F5]` (Later horizon)
- Voice-first ambient co-pilot (steer your build on a walk) `[N7 V5 F7]`
- Hands-behind-back / no-rm-rf challenge runs `[N6 V5 F5]`

**H. Reputation / credential.**
- Tradable, signed agent-supervision track-record token `[N8 V4 F6]`
- "Agent Operations" academy + certification flywheel `[N6 V4 F6]` (Later)

## Converge — shortlist

- ★ **Steer/control plane = the v1 wedge** (cluster A core: action-budget + panic kill + boss-fight).
  Highest weighted score, and the product *already has the control rails* (ttyd/cmux/tmux + the QA
  interrupt signal). This is what makes it "not Termius." Build the lock-screen approve/kill/cap loop
  into v1's terminal + alerts. `[N8 V8 F10]`
- ★ **Verifiable-trust artifacts → standard** (cluster B: attestation receipts + tamper-evident
  replay → later a licensed seal). Converts the trust *claim* into a defensible *moat* + an enterprise
  monetization path. Start with the append-only signed action log (cheap, ships with the control
  plane); the licensed-protocol play is the Later moonshot. `[N8 V6 F9]`
- ★ **Predictive fleet brain (lite → full)** — near-term = threshold/anomaly push alerts off Pulse +
  agent signals; Later = on-device model that pre-empts. Directly serves SREs + agent-operators. `[N7 V7 F9]`
- **Steer-session escrow / reverse-auction unblock marketplace** — the boldest two-sided play; park
  as a Next/Later bet once there's a user base (liquidity is the risk). `[N9 V5 F7]`

### Traps (attractive, but flagged)
- **Compute/relay marketplaces (D: idle-lease, agent-compute broker)** — turns a trust-first dev tool
  into a compute exchange: huge scope, abuse/security surface, dilutes positioning. Not v1.
- **Parametric insurance / academy / cert (E,H)** — need scale + brand + regulatory lift first.
- **Bio-adaptive gating (A)** — creepy + false-positives that block real work; only as opt-in,
  advisory-only, never a hard block.
- **Cringe gamification (G: streaks/achievements)** — seniors bounce instantly. Ambient/utility-framed
  only (widget = useful glance, not a Duolingo streak).

## Provocation

> **What if the phone is the *approval authority*, not a dashboard?** Every agent on every machine
> must get your tap — or a policy you cryptographically signed — before any irreversible action
> (push to prod, `rm -rf`, spend > $X, auto-merge). DevDashboard becomes the **consent layer for
> autonomous development**. The dashboard is just the surface; the product is *the gate*.

## Idea source files (this ADHD run)

- `DevDashboard/roadmap-ideas/01-competitor.md`
- `DevDashboard/roadmap-ideas/02-markets.md`
- `DevDashboard/roadmap-ideas/03-game-design.md`
- `DevDashboard/roadmap-ideas/04-infinite-budget.md`
- `DevDashboard/roadmap-ideas/SYNTHESIS.md` (this file)

Fold the ★ picks into `DevDashboard/PRODUCT-ROADMAP.md` Now/Next/Later when ready (deepen first).
