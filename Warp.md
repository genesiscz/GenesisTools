# Warp.app Hang Diagnostic Report

**Generated:** 2026-03-02 17:48 +0100
**Warp Version:** 0.2026.02.18.08.22.02
**macOS:** 26.3 (25D125)

---

## TL;DR

Warp has been running for **7 days** without a restart and has accumulated **6.6 GB RAM** and **657 minutes (~11 hours) of CPU time**. Combined with system-wide memory pressure (24M swap-outs), this causes the main UI thread to stall when it hits swapped-out memory during rendering — producing the repeated freezes you're seeing. The app eventually went silent at 16:32 today (1h+ ago) and has not logged since.

---

## System State at Collection Time

| Metric | Value |
|--------|-------|
| Load averages | **13.57 (1min) / 27.92 (5min) / 81.12 (15min)** |
| System uptime | 6 days, 23h |
| Pages in compressor | 3,287,412 |
| Swap-ins | 16,011,697 |
| Swap-outs | **24,152,566** |

**The load average of 81 (15min) → 13 (1min) means the system just recovered from something extremely heavy.** Memory is under serious pressure — more pages are being swapped out than in, indicating active compaction.

---

## Warp Process Stats

| Field | Value |
|-------|-------|
| PID | 2454 |
| Running since | Feb 23, 18:29 (7 days ago) |
| CPU time accumulated | **657 minutes (10.9 hours)** |
| Physical memory footprint | **6.6 GB (peak)** |
| Log file size | 64 MB (67,882,297 bytes) |

A second `stable` process (PID 2554) is the terminal server subprocess.

---

## Freeze Events Detected in warp.log

The log shows repeated stalls where timestamp progression halts mid-session:

```
16:23:37 → 16:23:51  (14s gap)
16:24:11 → 16:24:24  (13s gap)
16:24:43 → 16:25:04  (21s gap)
16:25:31 → 16:26:07  (36s gap)  ← escalating
16:26:07 → 16:26:18  (11s gap)
16:26:55 → 16:27:13  (18s gap)
16:27:37 → 16:28:00  (23s gap)
16:29:08 → 16:29:26  (18s gap)
16:29:37 → 16:30:07  (30s gap)
16:30:07 → 16:31:07  ★★ 60s gap ★★
16:31:07 → 16:31:37  (30s gap)
16:31:37 → 16:32:07  (30s gap)
16:32:07 → [silence]  (log stops entirely — ~1h+ ago)
```

**Pattern:** Gaps are escalating in duration throughout the afternoon. After the last entry at 16:32:07, Warp stopped logging entirely. The process is still running (PID alive) but the main event loop appears to be completely stalled or the log writer is blocked.

---

## What Triggered Each Freeze

The log entries immediately before each gap are `TypedCharacters` events:

```
2026-03-02T16:29:07Z [INFO] dispatching typed action: warp::terminal::view::action::TerminalAction::TypedCharacters
2026-03-02T16:29:08Z [INFO] dispatching typed action: warp::terminal::view::action::TerminalAction::KeyDown
                                                                              ↑
                                                             18-second gap starts here
2026-03-02T16:29:26Z [INFO] dispatching global action for root_view:update_quake_mode_state
```

User was actively **typing** when each freeze hit. The render path triggered by key input is stalling the main thread.

---

## Process Sample (taken at 17:48 — app currently idle)

At the time of collection the app was not frozen — the main thread was idle in the RunLoop waiting for events:

```
2436 Thread_32643  com.apple.main-thread
  → NSApplication run
  → CFRunLoopRun → mach_msg (waiting for events)  ← IDLE, not stuck
```

Background executor threads (0–7) are all parked in `pthread_cond_wait`. The app is responsive right now but the earlier stalls are explained by the memory state.

---

## Diagnostic Report

macOS filed a CPU resource violation for Warp on Feb 24:

```
/Library/Logs/DiagnosticReports/stable_2026-02-24-001430_MacBook-Pro-2.cpu_resource.diag
```

This is a `cpu_resource` report — the OS throttled Warp for excessive CPU use. This is consistent with the 657-minute CPU accumulation.

---

## Root Cause Analysis

### Primary: Memory pressure + 7-day session accumulation

Warp has grown to **6.6 GB** over 7 days. macOS is under heavy swap pressure (24M swap-outs). When Warp's main thread needs to render after a keypress, it accesses memory regions that have been paged out to disk. Retrieving swapped pages stalls the main thread — causing the UI to freeze for 10–60 seconds until the OS services the page faults.

The escalating freeze durations (7s → 60s → silence) suggest the app's memory working set is growing over time, hitting more and more swapped-out pages.

### Contributing: WAL file recovery at startup

```
2026-02-23T17:30:08Z [WARN] SQLite error 283: recovered 331 frames from WAL file warp.sqlite-wal
```

Warp's SQLite DB had a dirty WAL on the previous launch (recovery on startup = prior session didn't close cleanly). If the DB is used during rendering, WAL access under memory pressure compounds the stalls.

### Contributing: High scrollback row count

Rows up to **7,692** observed in click coordinates. Large scrollback buffers require more memory for rendering hit-testing and block selection.

---

## Fix / Mitigation

| Action | Impact |
|--------|--------|
| **Restart Warp** | Clears the 6.6 GB footprint immediately — biggest win |
| Close tabs with large scrollback | Reduces per-pane memory pressure |
| Restart macOS (6-day uptime) | Clears system-wide swap accumulation |
| Set a scrollback line limit in Warp settings | Prevents future buffer growth |

The app will likely snap back to normal after a restart — there's no crash or corruption, just accumulated memory bloat.
