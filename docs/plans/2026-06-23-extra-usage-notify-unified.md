# Extra Usage Notifications — Unified Architecture

> **Status:** Implemented (2026-06-23)

**Goal:** Any consumer that triggers a live Anthropic usage fetch (daemon, TUI `r`, watch, one-shot CLI) must be the single notifier for extra-usage transitions — without duplicate trackers or missed enable/disable banners.

**Architecture:** `getSharedAccountsUsage()` owns the notification pass. On every **fresh** fetch (inside the existing file lock, after cache write + history record), it calls `processExtraUsageNotifications()`. That function atomically updates `notificationPollTracker.extraUsageTrackers` in `~/.genesis-tools/claude-usage/config.json` **before** dispatching macOS notifications. Session/weekly alerts remain in `NotificationManager` (daemon + TUI).

**Root cause fixed:** Extra-usage lived only in poll-daemon with a separate in-memory tracker. TUI `r` refreshed shared cache but never notified. Worse: tracker state was saved *after* `dispatchNotification`, so a slow/hung dispatch left `lastKnownEnabled: true` and the daemon re-fired `EXTRA_DISABLED` every minute without ever persisting `false` or reliably showing the banner.

---

## Files

| File | Role |
|------|------|
| `src/claude/lib/usage/extra-usage-notify.ts` | **New.** Single owner: load trackers → detect transition → persist → dispatch |
| `src/claude/lib/usage/shared-cache.ts` | Calls `processExtraUsageNotifications` on live fetch only |
| `src/claude/lib/usage/notification-manager.ts` | Session/weekly only; preserves `extraUsageTrackers` on save |
| `src/claude/lib/usage/poll-daemon.ts` | Removed duplicate extra-usage path; top-level `await main()` |
| `src/claude/lib/usage/watch.ts` | Removed ephemeral extra-usage tracker (shared-cache handles it) |

## Config

- Toggle: `notifications.extraUsage` in `~/.genesis-tools/claude/config.json` (hidden JSON, default off)
- Tracker state: `notificationPollTracker.extraUsageTrackers` in `~/.genesis-tools/claude-usage/config.json`

## Notification rules (unchanged)

- `EXTRA_ENABLED` — first observation or `false → true`
- `EXTRA_DISABLED` — `true → false` (balance from last-known snapshot when API nulls fields)
- `EXTRA_SPEND` — every €5 spent while enabled
- Group: `claude-extra-usage` (separate macOS thread from session alerts)
- No `ignoreDnD`

## Verify

```bash
# Reset tracker to simulate "was enabled"
bun -e "
import { Storage } from './src/utils/storage/storage.ts';
const s = new Storage('claude-usage');
await s.atomicConfigUpdate((c) => {
  c.notificationPollTracker.extraUsageTrackers['reservine:extra_usage'].lastKnownEnabled = true;
});
"

# Live poll — should log EXTRA_DISABLED once + dispatched + daemon poll completed
bun run src/claude/lib/usage/poll-daemon.ts

# Second poll — no extra-usage log lines
bun run src/claude/lib/usage/poll-daemon.ts

# Tests
bun test src/claude/lib/usage/extra-usage-notify.test.ts src/claude/lib/usage/shared-cache.test.ts
```

## Future (out of scope)

- Unify session/weekly notifications into shared-cache the same way (TUI still has a separate `NotificationManager` without persisted state)
- Dedupe session/weekly notification flood when multiple accounts cross thresholds in one poll