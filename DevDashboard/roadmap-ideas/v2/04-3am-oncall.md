# ADHD diverge — 3am on-call frame

Vantage: you're asleep when something breaks. The pager wins if it can (a) tell you in one glance whether it's real, (b) let you triage + fix from the phone in 60 seconds, and (c) make sure you're not woken for the same thing twice. Peace-of-mind ambient awareness, smart thresholds + anomaly nudges, escalation, one-tap runbooks, "is it just me" context, snooze / auto-heal. The 3 banned obvious answers (push-notify-on-failure, live log tail, a red/green status dashboard) are off the table on purpose.

## Triage screens (fix it in 60 seconds)

1. **"Incident Cockpit" deep-link — one push opens a single pre-assembled screen, not the app's home**: the alert payload carries an incident id that lands you on a purpose-built triage view stitching the offending daemon's last 50 log lines + the Pulse sparkline at the moment of failure + a one-tap-into-the-right-tmux-session button, so you never navigate a 4-tab app half-asleep. `[screen]`

2. **"Diff since I fell asleep" timeline**: a vertical scrub of everything that changed on the machine since your last-seen timestamp — which containers restarted, which daemon flapped, the CPU/mem delta, which git branches moved — so the first question at 3am ("what actually happened while I was out?") is answered before you read a single log. `[screen]`

## Smart alerts (don't wake me unless it's real)

3. **Anomaly baselining on the Pulse history-db instead of fixed thresholds**: learn the per-hour normal band for CPU/mem/swap/disk-IO from the stored history and only page when a metric leaves *its own* envelope (a 90%-CPU build at noon is normal; the same at 3am with no active session is not) — kills the "it's always at 80%, who cares" alert fatigue. `[automation]`

4. **"Is it just me?" correlation card on every alert**: before paging, the rule engine cross-checks wifi/uplink health, a tiny upstream-reachability probe (GitHub/registry/Tailscale relay), and whether other watched machines see the same symptom — and labels the push **"local fault"** vs **"the internet is down, go back to sleep."** `[feature]`

5. **Flap suppression + auto-heal-then-confirm**: a service that crash-loops fires ONE consolidated "restarted 4× in 2 min, I restarted it, watching for 5 more" notification with an Undo, instead of four separate pages — the automation tries the runbook's first step itself and only escalates to you if its own fix didn't hold. `[automation]`

## One-tap action & escalation

6. **Per-daemon "runbook cards" you author once, fire from the lock screen**: attach an ordered list of named recovery commands to each daemon ("restart", "clear queue", "drain + redeploy") that render as big buttons on the incident push — Face-ID-gated, each runs in the daemon's own tmux/cmux session and streams its result back inline, so you fix it without ever typing a shell command. `[feature]`

7. **Escalation ladder with a dead-man's switch**: if you don't acknowledge a critical page within N minutes it climbs the rungs you defined — re-notify louder → trigger a HomeKit "wake scene" (flip the bedroom lamp, not just buzz) → finally fire a webhook to a teammate / secondary device — and auto-cancels the whole ladder the instant the underlying signal recovers on its own. `[automation]`

## Ambient peace-of-mind (so I sleep)

8. **"All-clear" bedside HomeKit ambient + a silent Live Activity that only surfaces on trouble**: a smart bulb you can glance at from bed glows calm-green while everything's nominal and amber/red on a real incident, paired with a Dynamic Island / Live Activity that stays collapsed-and-silent during healthy hours and only expands when a watched signal degrades — the feature is *being able to NOT check your phone* and trust the room to tell you. `[delight]`
