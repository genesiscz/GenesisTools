# DevDashboard — Product Roadmap & Audience Expansion

> **Scope.** This is the product/strategy roadmap, not the build plan. Every item below extends primitives that **already exist server-side** in the DevDashboard Agent (`src/dev-dashboard/`): **Pulse** system metrics (CPU / mem / swap / battery / disk / Wi-Fi), interactive **tmux/cmux terminals via ttyd**, the **QA live stream** (`qa-sse`), **Obsidian** note sharing, **Claude usage** aggregation, **daemon runs**, **Docker containers**, and **weather**. The roadmap turns "a dashboard you read" into "a control surface you act from — on your phone, from anywhere, provably private."
>
> Decisions referenced as **Dn** live in `DevDashboard/DECISIONS.md`. Nothing here contradicts a locked decision.

---

## 0. The one-line thesis

**You should never pay for privacy — privacy is the floor.** Every tier can prove "your machine, your keys, we can't see your data." You pay for **convenience** (one-tap managed remote, push alerts) and **scale** (fleet, teams, audit, SSO). The product that wins agent-developers is the one that lets you **steer an AI agent from your phone the moment it needs you** — without trusting a vendor to read your terminal.

---

## 1. Audiences — JTBD + the ONE killer feature

Each audience gets exactly **one** headline feature. Discipline is the point: one reason to install per persona.

### 1.1 AI-agent operators / "vibecoders" — *the primary, the spine*
- **Job-to-be-done:** "I have Claude Code / Cursor / Codex agents running in tmux/cmux sessions on my Mac. I'm away from my desk. I need to know the second an agent is *blocked on me* (a permission prompt, a question, a failing test, 'should I proceed?') — and I want to answer it from my phone without SSHing in."
- **Killer feature: Agent-needs-input push + remote approve/deny.** The Agent already watches sessions (QA live stream `qa-sse`, the interactive ttyd terminals, Claude usage). The roadmap adds: detect the "agent is waiting" state → fire a push → let you **approve / deny / type a one-line steer** from the lock screen, which writes straight back into the live tmux/cmux pane. You already *can steer* (ttyd is interactive); this makes it *notify-first* so you don't have to babysit.

### 1.2 SREs / on-call engineers
- **JTBD:** "A box is on fire at 2am. I need eyes and hands on it from my phone before I can get to a laptop."
- **Killer feature: Threshold alerts on Pulse metrics → tap straight into a live terminal.** Pulse already polls CPU/mem/swap/disk; the alert engine turns "CPU > 90% for 5 min" or "disk < 5%" into a push whose action button drops you into a live root-cause terminal on that host. Read → act in one tap.

### 1.3 Indie hackers / solo founders
- **JTBD:** "I'm shipping solo across a side project and a day job. I want to glance at 'is everything healthy and is the build green' without a tab graveyard."
- **Killer feature: Home-screen widget + Live Activity for builds/deploys.** One widget = build status + last deploy + a green/red Pulse dot. A Live Activity tracks a long build/deploy to completion on the lock screen. Glance, not log-in.

### 1.4 Remote & nomad developers
- **JTBD:** "I'm on hotel/café Wi-Fi or a phone hotspot. My dev machine is at home. I need a reliable, private link to it that survives flaky networks."
- **Killer feature: Seamless transport failover (LAN → Tailscale → tunnel).** The pluggable `Transport` (D5) auto-picks the best available path: same Wi-Fi → LAN; otherwise the Tailscale/WireGuard link (detected + deep-linked, no embedded SDK per D7); else the tunnel. The phone reconnects across network changes without you re-pairing.

### 1.5 Security-conscious teams / orgs
- **JTBD:** "I cannot let a third party see our terminals or metrics — but devs still want phone access. I need access I can *audit* and *prove* is private."
- **Killer feature: Verifiable end-to-end encryption + key-fingerprint verification.** Managed remote uses X25519 ECDH pairing → per-message AEAD; keys live ONLY on phone + Mac, never escrowed (D9). The app shows a **key fingerprint / safety number** you can compare out-of-band, plus self-host on your own `cloudflared` (D8) so the vendor is never in the data path. "Prove it" is a screen, not a promise.

### 1.6 Students / learners
- **JTBD:** "I'm learning the terminal and tmux. I want to follow along and run commands from my phone without a complicated SSH setup."
- **Killer feature: Zero-config LAN pairing via QR.** Same Wi-Fi + scan a QR (mDNS discovery, D6) = a working interactive terminal in seconds, no keys, no port-forwarding, no third party. The lowest-friction "real terminal on my phone" on the market.

### 1.7 Agencies / consultants (multi-client machines)
- **JTBD:** "I run work for five clients on five machines/VMs. I need them side by side, clearly separated, and I must never cross client data."
- **Killer feature: Multi-machine fleet view with hard per-machine isolation.** One list of all paired machines, each its own Pulse tile + terminal set + isolated credentials/keys. Switch client context in one tap; nothing bleeds across machines (separate E2E keypairs per pairing).

### 1.8 Content creators / streamers (render/encode monitoring)
- **JTBD:** "I kick off a long render/encode/export and walk away. I want to be told when it's done — or when it stalls — without watching a progress bar."
- **Killer feature: Long-job tracking with completion/stall push + Live Activity.** Any long-running daemon/process (existing daemon-runs view + container stats) gets a "watch this job" toggle → Live Activity ticks the progress, push on done/fail/stall. Built on the same alert engine as SRE thresholds.

---

## 2. Feature Roadmap — Now / Next / Later

Every item names the **audience(s)** it unlocks and the **existing primitive** it extends.

### NOW — v1 ships the control surface (foundation already chosen: Expo SDK 55, pluggable Transport, both ttyd drivers)
- **Interactive terminals on mobile** (tmux + cmux via ttyd, both WebView drivers + in-app switcher, D12). → *agent-operators, students, SREs.* Extends: ttyd/tmux/cmux.
- **Pulse metrics with Skia sparklines** (CPU/mem/swap/battery/disk/Wi-Fi; victory-native XL, D14). → *all, esp. SREs, indie.* Extends: `system/` collector + history-db.
- **QA live stream on mobile** (the `qa-sse` event feed, rendered + searchable). → *agent-operators.* Extends: `qa-sse`, `qa-search`.
- **Obsidian notes + Claude usage + daemon runs + containers + weather** read views (parity with web). → *indie, agencies, content creators.* Extends: existing `obsidian/`, `claude-usage/`, `daemon-view/`, `containers/`, `weather/`.
- **Three private transports, switchable** (LAN/mDNS, Tailscale/WireGuard detect+deep-link, self-hosted `cloudflared` guided wizard with QR pairing). → *remote/nomad, security-conscious, students.* Extends: `Transport` (D5–D8).
- **QR pairing + per-pairing E2E keys.** → *security-conscious, students.* Foundation for D9/D10.

### NEXT — agent-native + alerts (this is the differentiator; make it the backbone)
- **★ Agent-session monitoring + remote approve/deny.** Detect "agent waiting on input / finished / errored" across Claude Code, Cursor, Codex sessions → push with **Approve / Deny / type-a-steer** actions that write into the live pane. → *agent-operators (core).* Extends: `qa-sse` + Claude usage + interactive ttyd.
- **Push alerts engine (one engine, many triggers):** agent-needs-input, build done, CI fail, long-job done/stall, metric threshold breach. → *agent-operators, SREs, indie, content creators.* Extends: Pulse poller + `qa-sse` + daemon runs.
- **Managed one-tap remote (Pro) with E2E.** Vendor relay for zero-config remote — honest "we can't see your data" **because** of the E2E layer (D9/D11), not despite it. Metadata caveat surfaced in-app. → *indie, remote/nomad, agent-operators.*
- **Home-screen widgets + Live Activities + Lock-screen actions.** Build/deploy status, Pulse dot, long-job progress, agent-waiting badge. → *indie, content creators, SREs.* Extends: Pulse + alert engine.
- **Multi-machine fleet view.** All paired machines in one list, per-machine isolation. → *agencies, SREs, remote/nomad.* Extends: Pulse tiles + per-pairing keys.
- **Log & file streaming.** Tail any log, browse/preview project files, stream file changes — read-only first. → *SREs, agent-operators (read an agent's diff), indie.* Extends: Agent file/process access.
- **Command palette + saved snippets/macros.** Fuzzy "run X on machine Y"; saved one-tap commands (restart service, run tests, `git status`). → *SREs, agencies, agent-operators.* Extends: terminal write path.
- **Managed-domain option (no own domain needed).** `<name>.devdashboard.app` via Cloudflare for SaaS; same trust profile as managed (D10). → *indie, students.*

### LATER — platform, teams, intelligence
- **Apple Watch app + complications.** Pulse glance, agent-waiting tap-to-approve, alert triage from the wrist. → *agent-operators, SREs, indie.*
- **Siri Shortcuts / voice + App Intents.** "Hey Siri, is the build green?" / "approve the agent." → *agent-operators, indie, content creators.*
- **Cross-platform Agents (Linux / Windows).** *Genuinely Later* — today's collector is macOS-specific (`memory_pressure`, `wifiSsid`); this requires a per-OS metrics backend behind the existing `system/` interface. The unlock for server fleets. → *SREs, remote/nomad, agencies.*
- **Web client (responsive companion to the existing React UI).** The current `ui/` re-pointed at the `@devdashboard/contract` becomes a first-class desktop companion. → *all; esp. agencies, security-conscious (managed access from any browser).*
- **On-device AI summaries of logs / sessions.** "What did this agent do in the last hour?" / "summarize this 4k-line log" / "why did the build fail" — summarization runs on-device or via the user's own key (keeps the trust promise). → *agent-operators, SREs, indie.* Extends: QA stream + Claude usage + log streaming.
- **Session sharing & collaboration.** Share a read-only (or write-scoped, time-boxed) link to a live terminal/Pulse view. → *agencies (show a client), teams, content creators.*
- **Audit log.** Every remote action (command run, approval granted, session opened) recorded and exportable. → *security-conscious orgs, agencies, teams.*
- **SSO + Teams** (SAML/OIDC, role-based machine access, shared fleet). → *security-conscious orgs, agencies.*
- **Plugin / extensibility API.** Third-party "cards" and alert sources against the `@devdashboard/contract`; bring-your-own metric/agent integration. → *power users, agencies, orgs with bespoke tooling.*

---

## 3. Monetization — priced on convenience & scale, never on privacy

> **Hard rule (D11):** the unconditional "we can't see your data" promise holds on **every** tier including Free. Paid tiers buy *convenience* and *scale*, not privacy. Managed remote is **E2E**, not a privacy downgrade.

### Free — *Self-host & private by default*
- LAN/mDNS, Tailscale/WireGuard, and **your own `cloudflared`** (D6–D8). Vendor is never in the data path.
- Full feature set on the local/self-host transports: terminals, Pulse, QA stream, Obsidian, Claude usage, daemons, containers, weather.
- 1 machine, on-device alerts (when the app is foregrounded / via your own infra).
- **Pitch:** "Everything works, fully private, forever. Bring your own pipe."

### Pro — *Managed remote + push alerts* (per user / month)
- One-tap **managed remote** with the E2E layer (D9) — no Tailscale/tunnel setup required.
- **Reliable push alerts** even when the app is closed: agent-needs-input, build/CI, thresholds, long-job done.
- Widgets, Live Activities, Watch app, Siri Shortcuts, command palette/macros.
- Optional **managed (sub)domain** (D10) for users without their own.
- **Pitch:** "We do the networking and the pinging. You still hold the keys."

### Team — *Fleet + collaboration* (per seat / month)
- Multi-machine fleet view, per-machine isolation, session sharing, on-device/own-key AI summaries.
- Shared alert routing, basic roles.
- **Pitch:** "Your whole fleet on every phone, cleanly separated."

### Enterprise — *Governance & self-host support* (annual)
- **SSO** (SAML/OIDC), **audit log** export, role-based machine access.
- **Self-host support contract** for the managed relay (run the vendor relay inside your own perimeter) + the verifiable-E2E story for compliance.
- Priority support, security review artifacts (key-handling docs, fingerprint verification flow).
- **Pitch:** "Phone access your security team can audit — and prove is private."

---

## 4. Moat & positioning vs alternatives

**The moat is the *combination*: verifiable trust × agent-native, in one switchable app.** Neither incumbent has both.

- **vs Termius / Blink / SSH clients** — They give you a great mobile terminal, but you're still the one who has to *be looking*. DevDashboard is **notify-first and agent-aware**: it tells you when an agent or build needs you, shows Pulse/QA context around the terminal, and lets you approve from the lock screen. Terminal is table-stakes here, not the product.
- **vs generic monitoring apps (Datadog/Grafana mobile, uptime pingers)** — Those are read-only dashboards for *servers you operate at scale*. DevDashboard is **read + act on your own dev machine(s)**: the metric alert drops you into a live terminal, and it understands AI-agent sessions, not just hosts.
- **vs "remote desktop / one-tap cloud" tools** — Those put a vendor in the middle of your screen. DevDashboard's whole identity is **the vendor is not in the data path** (self-host tiers) or **cannot read it** (managed = E2E, verifiable via key fingerprint). "Your machine. Your keys. We can't see your data — and you can prove it."
- **vs rolling-your-own (ttyd + Tailscale + a bookmark)** — That's literally where this started. DevDashboard productizes it: pairing wizard, push alerts, agent detection, widgets, fleet, audit — the 90% nobody builds for themselves.

**Defensibility compounds:** the agent-session intelligence (what a "waiting agent" looks like across Claude Code / Cursor / Codex), the verifiable-E2E pairing UX, and the per-OS metrics backend are each a multi-quarter build that a generic SSH client won't bolt on without rearchitecting around trust.

---

## 5. Positioning statement + taglines

**Positioning statement**
> DevDashboard is the mobile control surface for developers who run their machines — and their AI agents — from their phone. It streams your live terminals, system Pulse, and agent sessions to iOS, then pings you the moment an agent needs input or a build breaks, so you can approve, steer, or jump into a live shell from the lock screen. Unlike SSH clients (read-only attention) and cloud monitoring apps (vendor in the middle), DevDashboard is private by architecture across every tier: LAN, Tailscale, your own Cloudflare tunnel, or managed remote with end-to-end encryption whose keys live only on your phone and your Mac — a promise you can verify, not just trust.

**Candidate taglines**
1. **Your machine. Your keys. We can't see your data — and you can prove it.**
2. **Run your machine — and your agents — from your pocket.**
3. **The dev dashboard that pings you when your agent gets stuck.**
