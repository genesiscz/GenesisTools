# iOS Simulator control — measurements

Everything here was measured on this machine, not assumed. Re-measure before changing the
observation path; the probe sweep is the hot loop of every simulator read.

Rig, 2026-09-19:

- macOS 26 (Darwin 25.3.0), Apple Silicon
- Xcode 26.6 (17F113), one runtime: iOS 26.5 (23F77)
- Device: iPhone 17 Pro, `7E643E76-…`, booted, Simulator.app open, screen 402x874 points
- `idb` and `idb_companion` from Homebrew, on `PATH`
- App under test: iOS Calendar, `com.apple.mobilecal`

## 1. Which mechanism can see iOS elements at all

Three candidates were compared on the SAME screen state. The question is not "which is
faster" but "which returns real element labels and identifiers".

| Mechanism | What it returned on Calendar's day view |
|---|---|
| macOS AX on the Simulator.app window (`tools control see --app Simulator --depth 40`) | 19 rows: 15 host-chrome rows (Action, Volume Up/Down, Sleep/Wake, toolbar, traffic lights) plus the SAME 4 bridged iOS rows idb reports |
| `idb ui describe-all` | 5 rows: the app root, `DayViewContainerView`, `current-day`, one day group, `Toolbar` |
| `idb ui describe-point` | the real leaves, with the app's own identifiers |

The decisive control: `tools control find --app Simulator --q "Add" --depth 40` returned
**0 matches**, and `add-plus-button` does not appear anywhere in `tools control tree --app
Simulator --depth 40` (1035 bytes of output). `idb ui describe-point 370 110` on the same
screen returned:

```
Button "Add" id="add-plus-button" frame=345,66 37x36
```

So the host Accessibility API and idb read the SAME bridged tree and stop at the same depth.
Neither sees more than the other at the top level. **idb wins on the act side and on
addressing**, not on what `describe-all` reveals:

- coordinates are already in device points, so no window-offset, scale or title-bar maths
- it acts without moving the host pointer, without focusing Simulator.app, and works while the
  window is occluded or on another Space
- its verbs (`tap`, `text`, `key`, `key-sequence`, `swipe`, `button`) map one-to-one onto the
  actions this feature needs
- device lifecycle (`simctl list/launch/terminate/io screenshot`) is in the same family

The host AX path additionally forces every read to carry 15 rows of Simulator.app chrome that
have nothing to do with the app under test, which a model would have to be told to ignore.

**Chosen mechanism: `idb` for observation and action, `xcrun simctl` for device and app
lifecycle.**

## 2. Why a probe grid is required

`describe-all` reports only what an app publishes at the top of its accessibility hierarchy.
A container that aggregates its children hides them completely, and iOS Calendar's day view
does exactly that.

| Read | Elements | Contains `add-plus-button`? |
|---|---|---|
| `describe-all` (flat) | 5 | no |
| `describe-all --nested` | 5 | no |
| 40-point grid of `describe-point` | 32 | yes |

The grid also surfaced `today-button`, `calendars-button`, `inbox-button`, `searchbar-button`,
`toggle-day-list-view`, `BackButton`, the seven day buttons and every hour slot. None of these
are reachable any other way.

### `describe-point` is a hit test with touch slop

It is not a strict rectangle test. Probing `(370, 110)` returned the Add button whose frame is
`y 66..102` — 8 points below the frame, because iOS expands small targets toward the 44-point
minimum. When a point hits nothing, it returns the full-screen root group.

Consequence for the design: `describe-point` is trustworthy for **identity** ("what would a tap
here hit"), which is exactly what the pre-dispatch freshness guard needs, and is NOT usable as a
geometric containment test.

## 3. Probe sweep cost

402x874 screen, 40-point grid = 220 points. Each `describe-point` is one process.

Direct `Bun.spawn`, no watchdog:

| Concurrency | Elapsed | Per point | Distinct elements |
|---|---|---|---|
| 8 | 12032 ms | 54.7 ms | 32 |
| 24 | 6343 ms | 28.8 ms | 32 |
| 48 | 3997 ms | 18.2 ms | 32 |

Concurrency buys wall time and changes nothing about the result. 48 is the shipped default.

**The shipped path is ~2.3x slower than the table above, deliberately.** It goes through
`boundedCommand` from `@genesiscz/utils/process/bounded-command`, which prefixes every child with
the `argvWithChildDeadline` perl fork watchdog so a parent crash cannot leave children spinning.
Measured on the shipped path: 248 points in 10626 ms = **42.8 ms per point** at concurrency 48,
against 18.2 ms raw. That is one extra `perl` process per probe point.

This cost is accepted rather than engineered away: the repo's process rules exist because
unbounded children have burned real hours here, and a hot loop is the worst place to make an
exception. The lever for a faster read is fewer points (`--probe-step`, `--max-points`), not a
weaker deadline.

End-to-end `tools control sim see` on the shipped path:

| Screen | Probe points | Observation | Command wall |
|---|---|---|---|
| Permission alert (7 elements) | 220 | 3898 ms | 6.7 s |
| Calendar day view (37 elements) | 248 | ~9.4 s | ~11 s |

`idb ui tap` itself is **0.25 s**, so dispatch is not the cost; reading the screen is.

## 4. The screen rectangle must come from the application root

First implementation took the screen as the largest observed element. A scroll view reports its
whole scrollable content, and Calendar's day view reports **338x1237 inside a 402x874 screen**.
Taking that as the screen:

- aimed the probe grid at x 0..338, so the entire right-hand column was never probed and
  `add-plus-button` (x 345) was lost — a regression that a passing read would have hidden
- spent most of its points below y 874, where nothing is visible

Fixed by reading the screen from the `AXApplication` row, and by clipping every element frame to
the visible screen so a tap on a tall scroll view lands on a visible pixel. Pinned by
`screenFrom` tests in `src/control/lib/simulator/simulator.test.ts`.

## 5. The window id must not follow the foreground app label

First implementation keyed `Observation.window.id` on the app's root accessibility label, so that
`sameScope` would refuse to keep acting after an app switch. Dismissing the Calendar location
permission alert changed that label from `SpringBoard` to `Calendar`, and a routine alert
dismissal aborted the task with "Simulator foreground app changed".

Fixed: `window.id` identifies the **device screen**, and app identity is carried by `pid`, read
from `simctl spawn <udid> launchctl list` on every observation when a `--bundle-id` is given. A
relaunch changes the pid and still stops the task; an alert does not.

## 6. What was proven on the live device

Full run against the booted iPhone 17 Pro, in order, each step verified by reading the screen
again afterwards:

1. `sim devices` listed the device and its booted state
2. `sim launch --bundle-id com.apple.mobilecal` reported `alreadyRunning: false`, pid 77228; the
   second call reported `alreadyRunning: true` with the same pid (bring-to-front)
3. `sim see` returned 37 addressable rows with correct depth and the app's own identifiers
4. `sim act --element 10 --action press` (`add-plus-button`) opened the New Event sheet; the
   readback showed `title-field`, `add-button`, `cancel-button` and the keyboard
5. `sim act --action type --text "Standup with the team"` on `title-field`; the readback showed
   `title-field` value `"Standup with the team"`
6. `sim act --element 8 --action press` (`add-button`, "Done"); the readback showed
   `event-shown:Standup with the team` back in the day view, confirmed by screenshot
7. `sim act --action scroll --direction down --pages 1` moved the hour labels from
   `0:00 … 12:00` to `5:00 … 20:00`
8. Replaying a decision taken against a screen that had since changed was **refused**, exit 1:
   `The chosen element (id:add-plus-button) is no longer on screen. The screen moved while the
   decision was being made; observe again.`

## 7. Known limits

- `set`, `paste`, `select` and `perform` are refused by name. `set` would need a reliable clear,
  which iOS does not offer through idb; `type` is the supported path.
- Elements are discovered at grid resolution. A control smaller than `--probe-step` that no
  `describe-all` row covers can be missed. The shipped 40-point step found every control on the
  Calendar screens tested; a denser step costs linearly.
- A truncated sweep is reported as `probe.truncated: true` and the CLI warns. It is never
  silently presented as a complete screen.
- Only one booted simulator is driven implicitly; two or more require `--udid`.
