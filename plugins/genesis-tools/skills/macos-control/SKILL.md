---
name: macos-control
description: Use when inspecting or operating macOS apps, browser tabs, menus, forms, dialogs or multiple displays; demonstrating native Jev control; debugging stale AX trees, focus, cursor feedback or URL replacement; or recording and reviewing short screen transitions.
---

# Native macOS control

GenesisTools owns this stack: Accessibility, CoreGraphics, ScreenCaptureKit and local Vision OCR. `tools control`, `tools macos control`, `tools jev control` and the agent-facing `tools computer-use` share the same control core. The latter's `run` executes TypeScript; `control run` executes a declarative plan. They are not different automation providers.

For this workflow, use no Codex Computer Use/Sky service, AppleScript, Python, icon detector or larger-model fallback. Ordinary actions need no AI. Jev is the only semantic evaluator and requires explicit opt-in; direct TypeSafe and Vercel Gateway both use Vercel AI SDK. Do not substitute an external provider to turn a failed native demonstration into a success.

## Start on the right build

`tools` on PATH may run the main checkout while a worktree contains the current implementation. From a worktree use:

```bash
bun src/computer-use/index.ts prepare
bun src/computer-use/index.ts run --help
bun src/control/index.ts act --help
```

Check the command named by help, not just exit zero. Do not guess command plurals: JavaScript has `computer.list_windows({app})`; the human CLI has `tools control window --app APP`, not `control windows`. First-use native compilation is preparation time, not ordinary action latency. Use the supported launcher; permission errors identify the responsible process. A shared app-build lock refuses new launches until replacement finishes.

## Choose the interface

| Need | Interface |
| --- | --- |
| Several adaptive actions with fresh state and one deadline | `tools computer-use run --file task.ts --json` |
| Persistent agent session | `tools computer-use mcp` or `mcp --repl` (`computer` is preloaded) |
| One validated CLI action | `control see` → `control act --refresh` |
| Cheap read-only discovery | `control apps`, `window`, `find`, `attrs`, `actions`, `dump`, `hittest` |
| Bounded semantic task, fill, wait, recovery or replay | Shared APIs in [providers.md](references/providers.md) |
| Recording and frame review | Explicit native capture plan; [capture.md](references/capture.md) |
| Animation/resize proof and contact sheets | One recording/action timeline; [capturing-animations.md](references/capturing-animations.md) |

Read [automation-playbooks.md](references/automation-playbooks.md) before browser input, modal recovery, a Jev demonstration or multi-app execution. It contains complete examples and the failure-to-fix table. Read [native-cli.md](references/native-cli.md) for selector/snapshot/coordinate/plan contracts. [providers.md](references/providers.md) maps the standalone API, MCP and REPL.

## Don't take the user's focus

The user keeps working while an agent drives their Mac. A call that brings an app to the front or moves the pointer interrupts them, and the keys they type next land in the agent's window.

- **The background is the default.** `click` without `physical` or `prepare` uses AXPress or a window-addressed click. Use `press_key({..., activate:false})`, `set_value` without `prepare`, `fill_form({..., activate:false})` and `launch_app({path, activate:false})` (or `bundle_id`). `scroll` posts to the window. Open URLs and files with `open -g`, never with a bare `open -a` or `open -R`.
- **These take focus or the pointer:** `prepare:true`, `physical:true` on a browser page, `press_key` and `launch_app` with their default `activate:true`, `drag({background:false})`, and hover. Use them only for a visible demonstration the user asked for.
- **Under an agent, ax-tool refuses them while the user works.** A key, click, move or scroll in the last 5 s gives refusal `user_active` with `dispatchState:"not_started"`: nothing was sent. Do not retry in front; take the background path the error names. For a demonstration the user asked for, pass `allow_foreground:true` (CLI `--allow-foreground`, or `GENESIS_CONTROL_ALLOW_FOREGROUND=1` for a whole run). `GENESIS_CONTROL_FOREGROUND_IDLE=<seconds>` sets the quiet time, and `0` turns the check off. A person running a command is never refused.
- **A background click can do nothing.** A window-addressed click into an app that is not in front lands in a window that is not key. A SwiftUI control there (a sheet's "Cancel") takes it as the activation click and does nothing, yet the call returns `ok:true` with an `effectNote`. AXPress (a click without `physical`) acts without focus, but it sends no mouse event, so an app's NSEvent monitor does not see it. Check the postcondition after every background click.
- **Start apps with `launch_app`.** It goes through LaunchServices, as a Finder double-click does, so the app is its own process: its menu-bar item and its privacy prompts belong to it, not to the terminal. Do not run an app's binary from a shell, and do not open it through Finder's `AXOpen` (AX -25205 on a list item, and `/Applications` exceeds the observation budget).

## Execute the requested task

1. Observe running apps and current windows. Pick a unique observed `window_id`; indexes reorder. Without one, `get_app_state` takes the only real window and ignores popups (a translate bubble, a hover card); with two real windows it refuses and names each `window_id`. Use `scope:"chrome", image:false` for browser tabs and address controls, `scope:"window"` for page content. Never turn a read timeout, oversized tree or permission error into evidence that a window is empty. When a page or an open panel exceeds the snapshot limit, observe one element with `get_app_state({app, window_id, query, role})`: the whole window is walked, only matches and their ancestors become rows, the refs work with `click`/`press_key`, and the state text says how many subtrees depth left unwalked.
2. Check for a visible `AXSheet` or explicitly modal container before choosing background controls. Snapshot dispatch blocks targets behind it. If the fast tree has empty roles/geometry, it is incomplete evidence: the backend falls back to normal AX reads. Inspect the dialog's text and act only within the user's authorization; no automatic acceptance of installs, authentication or permissions.
3. Construct bounded candidates locally. Exact identity/filtering comes first; Jev decides meaning when requested. Distinguish repeated labels by subtree, URL, role and nearby text. A `Source` link for React differs from TypeScript Source; an update page may contain two `Info` buttons. Do not send supplied form values to Jev.
4. Act through the newest reference, in the background (see above). `prepare:true` focuses the window first: use it only for a visible demonstration the user asked for, or for a browser control that ignores background input while the user is away. A prepared native action with its original target fingerprint can automatically recover from a confirmed `not_started` stale/focus refusal, at most twice within a 1.5-second admission retry window. Every attempt uses the remaining original deadline, including action readback. This repeats admission, not completed workflow steps or Jev decisions. When a retry finds the target changed or gone, the call reports `effect:"unknown"` with every attempt's refusal (and what held focus): no attempt posted the input, but the UI moved after the first attempt focused it, so observe before repeating. Native AXPress/value writes can remain unfocused; high-level tasks prepare automatically where needed. For a visible demonstration, deliberately foreground the exact window and keep cursor feedback on.
5. Verify a fresh postcondition. Dispatch is not completion. Use exact URL/title/value/state where available; `expected_url` pins compound browser tasks. Unknown delivery stops mutations. Read fresh state to discover what happened; do not repeat the input just because readback failed.

## Contracts to remember

- **Insertion is not replacement.** `paste` inserts at the current selection. Whole-field replacement is `paste({app, element_ref, text, replace:true, prepare:true})`; it proves the whole-field selection before cmd+v, verifies exact readback, and restores the clipboard on every path. A result without `clipboardRestore:"restored"`/`"unchanged"` says `CLIPBOARD NOT RESTORED` or `CLIPBOARD STATE UNKNOWN`; tell the user. Double-click often selects one word. Preserve the original address/draft and restore it explicitly in cleanup; Escape need not undo an AXValue write.
- **Fill without taking the user's focus.** `set_value({app, element_ref, value})` without `prepare`, or `fill_form({..., activate:false})`, writes AXValue inside the app: no activation, no clipboard, no keys, so the user can keep typing. It works on Chromium/Electron pages too (measured on T3 Code, 2026-10-13); the readback waits up to 1 s because Chromium applies the write late. The cursor label shows the text written (a secure field shows bullets). A field that saves its draft on blur or Return keeps the text unsaved while the app is in the back; fill that one in front with `paste({..., replace:true, prepare:true})`.
- **Jev abstention stays an abstention.** Do not lower thresholds or retry the same question until it accepts. Improve genuinely missing evidence, narrow an ambiguous scope, or return a host packet. An independently justified exact host selection must be reported separately from a model choice. Host replies revalidate fresh evidence and consume no extra model call.
- **Bound every loop.** `assist_task`, `fill_form`, `run_workflow` and `await_condition` share deadlines and request/action caps. Waits may use exact local evidence without Jev. Supply an `evidence_scope` to ignore changing unrelated panels; missing/ambiguous scope stops.
- **Name the window.** `click`, `press_key`, `set_value`, `type_text`, `paste`, `scroll`, `drag` and `find` take the `window_id` that `get_app_state` took, and refuse with `WRONG_WINDOW` when the app's latest observation is another window. `list_windows` returns `{windows:[…]}`, not an array. `drag` needs a `get_app_state` observation first, because its coordinates are that observation's pixels.
- **A changing label refuses a pointer click.** A physical click on a panel whose label ticks (a running clock) can refuse with "observed target changed"; AXPress on the same button is pinned by identity and works. Right after a sheet button, the tree can briefly show no `AXSheet` while the sheet is still up, so wait for the change with `await_condition` or a fresh `get_app_state` before the next click.
- **Scrolling never takes focus, and can move like a person.** `control scroll --direction` posts to the window, not the frontmost app. Every scroll is animated like a trackpad swipe (0.25 to 1 s by distance; `--time 0` is one wheel event). To reproduce scroll bugs give a real `--time` (with `--repeat`/`--alternate`), never a loop of short scrolls; details in [native-cli.md](references/native-cli.md#scrolling-control-scroll). In a recording plan it is ONE scroll action with `time`, and the movie records at 60 fps by default: [capture.md](references/capture.md#duration-sampling-and-input).
- **Native dropdowns are exact.** `AXPopUpButton` selects one enabled observed menu title and reads it back. Duplicate/missing choices refuse. `AXInvalid` stops subsequent form writes where the app exposes it. Arbitrary custom web dropdowns need their own observed workflow.
- **Reference freshness and visibility are different.** Pin process/window/document, reobserve after changes, and use one-use pixel evidence for coordinates. Multiple displays can have negative origins and different scales. API coordinates default to screenshot pixels; native `act --coords` uses global screen points.
- **An overlay is not input proof.** Feedback waits for the helper to submit its layers, finish its glide and receive two display callbacks before input. Set `GENESIS_CONTROL_CURSOR_WAIT=required` for demonstrations so missing feedback stops input; ordinary feedback remains bounded best effort. Drag waits before mouse-down, then streams movement. Post-wait target checks remain authoritative. Verify the app's result independently. If a pixel test disables feedback, say so and record a separate visible proof.

## Demonstrations and timing

If the user asks to select goals, present the choices and wait. After selection, show the exact command and readable script, then execute the authorized selection without another permission ritual. Reobserve windows before running; a title or tab may have changed since planning.

Run the sequence in one script/REPL rather than model round trips for each literal button. Use Jev for bounded choices; exact supplied digits/strings stay in code. If the user explicitly requests Jev per step, honor that and report the additional requests. Preserve drafts and don't submit forms implicitly.

Record per-goal result, verification, wall time, Jev requests/time and deliberate presentation pauses. Record preparation/debugging time separately when measured. Keep failed attempts. The sum of successful reruns is not end-to-end request latency or proof of universal parity with another tool. Runner exit zero or an outer `ok:true` does not override failed inner task results.

For plan-completion or benchmark claims, use [acceptance-audit.md](references/acceptance-audit.md). Feature presence and a successful demonstration do not close the original acceptance criteria. It includes the decision-only threshold comparison and the source-versus-installed-skill check.

## Verify this skill

```bash
bun plugins/genesis-tools/skills/macos-control/scripts/check-help.ts --repo .
bun plugins/genesis-tools/skills/macos-control/scripts/check-api.ts --repo .
```

These are read-only contract checks, not desktop proof. Live, explicitly selected smoke modes are documented in the playbooks. Source updates do not change an already-loaded skill or installed cache until the plugin is refreshed. Keep [Peekaboo](references/peekaboo.md) as an explicitly selected legacy integration only; [publishing](references/vitrinka.md) is separately authorized.
