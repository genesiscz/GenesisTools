# computer-use

An independent macOS Computer Use API and MCP server over GenesisTools' native Accessibility, CoreGraphics and Vision code. It does not import or call Codex Computer Use, Sky, AppleScript or a browser automation service.

```bash
tools computer-use prepare             # compile the native backend before latency-sensitive work
tools computer-use mcp                 # native UI tools over stdio
tools computer-use mcp --repl          # persistent JS/TS; global computer is preloaded
tools computer-use run --file task.ts  # one script from the shell
```

The same entry points are reachable through `tools jev control mcp` and `tools jev control computer-run`.

```ts
const state = await computer.get_app_state({
    app: "com.example.App",
    image: false, // fast AX-only state; enable images for screenshot coordinates
});
const match = computer.find({ app: state.app, query: "Save" }).elements[0];
const result = await computer.click({ app: state.app, element_ref: match.ref });
nodeRepl.write(result.state?.text);
```

For a direct Bun import:
`import { ComputerUse } from "../control/lib/computer-use/session"; const computer = new ComputerUse();`
Use the repository REPL or Bun; no OpenAI runtime is required.

## API

- `get_app_state`: retained revisions, indexed elements, AX text, automatic diffs, optional native screenshot/OCR. A uniquely observed browser page is returned as top-level `document: {url,title,ref}`, so fills and workflows can pin `expected_url` without searching rows. `image:false` uses one AX traversal; screenshots retain matching AX reads around capture. Read-only instability retries are bounded by the operation deadline.
- `list_windows`: inspect AX window indexes and bounds without activating the app.
- `get_menu`: inspect top-level menu items, or one exact `top_menu` subtree, with separately scoped refs.
- `perform_menu_action`: invoke an exposed menu action such as AXPress or AXCancel; requires the app frontmost and fresh menu evidence.
- `list_apps`: running native apps and bundle IDs; `installed:true` inventories application bundles.
- `launch_app`: exact bundle ID or absolute .app path through NSWorkspace.
- `quit_app`: normal quit of the observed process instance; does not force-close unsaved documents.
- `click`, `drag`, `scroll`: observed references or image coordinates. Accessible single clicks use an observed AXPress; `physical:true`, right and double clicks use native pointer events.
- `set_value`, `select_text`, `paste`, `type_text`, `press_key`, `focus`, `perform_secondary_action`.
- `assist_task`: runs observe → choose → prepared action → verify inside one call. Exact mode requires an exact postcondition and uses no AI. Set `chooser:"jev"` or `"auto"` together with `jev:true` for semantic decisions. Optional `recovery:{mode:"bounded",remedies:[...]}` permits only explicitly described dismiss/back controls, with a separate recovery cap. The entire task shares one deadline, action cap and request cap; unknown delivery stops it. `expected_url` pins browser observations including action readback.
- `fill_form`: explicit `jev:true` maps 1–20 named string values to observed writable fields or native dropdowns, uses prepared exact writes, verifies every readback and never submits. Supplied values remain local; Jev sees field meaning and bounded UI evidence only. Use `expected_url` to pin a browser document against tab changes.
- `run_workflow`: runs a versioned 1–50 step workflow inside one pinned app/window with prepared targets, fresh postconditions, one shared deadline/action/request budget and no retry after uncertain delivery. Values remain local. Exact workflows make no AI call; semantic checks or selector repair require `jev:true`. Use `expected_url` to pin browser automation to one document.
- `find`: local search over the full retained observation; no AI.
- `get_elements`: page through retained rows without another native call. State responses default to 100 rows and 500 characters per text value; truncation is explicit. Use offset/limit/text_limit for more detail, or element_limit on get_app_state. Cached pages keep the original observation timestamp and reject a stale revision.
- `resolve_target`: optional `query`, `role` and `within_ref` explicitly narrow large pages without silently truncating evidence. Exact selection by default; `chooser:"jev"` or `"auto"` explicitly enables Jev. `within_ref` narrows to an observed subtree.
- `verify_state`: fresh exact readback, or semantic verification with explicit `jev:true`.
- `await_condition`: readiness through native AX notifications and bounded fallback in a previously observed app/window. Supply `exact:{identifier:"status",value:"Saved"}` for local readback with zero AI requests, or `jev:true` for semantic judgment. `expected_url` can pin the document. `evidence_scope:{identifier:"export-panel"}` or an exact `label` with optional `role` limits decision evidence to one observed subtree: unrelated clocks or status panels then spend no requests. A missing or ambiguous container stops the wait. Without a scope, the full observed window supplies evidence. The wait performs no actions and invalidates old refs; observe again afterward.
- `close_session`: discard cached state, without quitting the app.

Every asynchronous call accepts an optional `signal` in its argument object. The native bridge owns and bounds its child process group. Ordinary UI calls use no AI; the only AI request path is Jev, through `provider:"typesafe"` or `"vercel"`. An uncertain chooser returns evidence for the current host; it never starts another model.

`resolve_target` accepts `host_decision:{packet,answer}` for an explicit reply to an earlier escalation. It rereads the native window, rebinds any fingerprinted subtree, and checks packet expiry, scope, candidates and evidence before returning a current ref. A valid host reply consumes zero additional model requests. Repeat the original intent and scope filters. `assist_task` accepts the same reply and consumes it at most once; any later semantic choices or verification still require Jev opt-in and share the task budget.

The CLI uses the same wait scope through `tools control await --app APP --condition "Export complete" --evidence-id export-panel` (or `--evidence-label` with optional `--evidence-role`). Scope narrows evidence only; the full app/window/document guards, cancellation, deadline and request limit still apply.

```ts
const chosen = await computer.resolve_target({
    app: "com.example.App",
    intent: "Open the account preferences",
    chooser: "auto",
    provider: "typesafe",
});
if (chosen.ref) {
    const acted = await computer.click({ app: "com.example.App", element_ref: chosen.ref });
    nodeRepl.write(acted);
}
```

## Reference and coordinate contract

Use `element_ref` from the latest state. A stale revision is refused. Numeric `element_index` works immediately after `get_app_state`; after an action, observe again or use an explicit ref/revision from its returned state. Actions return dispatch facts separately from task verification. Unknown delivery never retries.

Coordinates default to **pixels of the returned window screenshot**, with origin at its top-left. The API converts Retina scale and negative screen origins explicitly. Set `coordinate_space:"screen"` only for logical global screen points. Coordinate actions consume screenshot evidence once and revalidate pixels before dispatch; visual evidence expires after 30 seconds.

Typing/paste/keys require the target app/window/input to be focused. Call `focus` explicitly or opt into `prepare:true`; there is no global keyboard fallback. `type_text` is single-line and at most 256 UTF-16 units; use `paste` for longer or formatted text. Paste restores the clipboard best effort. Secondary actions must match currently exposed AX actions.

`paste` inserts at the current selection by default. To replace an entire address or text field, use `paste({app, element_ref, text, replace:true, prepare:true})`. Replacement selects all inside the prepared field, pastes once, and requires exact value readback. `replace:true` without preparation is rejected before any native call. Double-click selects a word in many fields and is not a replacement operation. To undo a temporary URL draft, restore the captured original value explicitly; Escape need not undo a direct AXValue write.

Multiwindow apps require `window_id` or `window_index` on the initial observation. `list_windows` returns a native `window_id` where available; compare these IDs to identify a newly opened window even when titles are identical or ordering changes. Later observations stay on that window. A replaced app instance invalidates the session. Eight apps may be retained per client.

## Prepared interactions and multiple displays

`click`, `press_key`, `paste`, `type_text`, `select_text` and `set_value` accept `prepare:true`. This explicitly authorizes native focus and reveal before the requested action, inside one native invocation. It uses the observed target fingerprint to survive unrelated page updates, requires a unique match in the same process/window, and revalidates the retained element, semantic attributes and hit ownership before input. Prepared browser buttons use focused Space and links use Return because Brave can acknowledge AXPress without delivering the DOM activation; native controls retain AXPress. Prepared `set_value` replaces a controlled web field through select-all plus clipboard-safe paste and requires exact readback, while native fields keep direct AXValue writes. Set `physical:true` when pointer hit testing is the behavior under test. Changed or ambiguous targets refuse. A dispatched or uncertain mutation is never repeated. Coordinates and OCR regions cannot use preparation because scrolling/focus can invalidate pixels.

Higher-level `fill_form`, `assist_task` and `run_workflow` use automatic preparation, shared with CLI fill/assist/replay-plan: visible native AX presses and value writes do not request foreground focus. Browser descendants and keyboard/text-selection operations prepare when required. This avoids unnecessary focus changes; an application can still activate itself in response to an AX action. Explicit primitive `prepare:true` keeps its original meaning. Semantic candidate admission still excludes hidden targets.

```ts
await computer.get_app_state({app:"com.brave.Browser",window_index:0,image:false});
const choice = await computer.resolve_target({
    app:"com.brave.Browser", intent:"Open the forecast", role:"AXLink",
    query:"forecast", chooser:"jev", provider:"typesafe",
});
if (choice.ref) {
    await computer.click({app:"com.brave.Browser",element_ref:choice.ref,prepare:true});
}
```

Elements expose their observed `url` where AX supplies one. Cursor feedback carries the source display ID and display-local point, uses a panel on the target display, and refreshes placement when displays change. `tools jev control cursor preview --coords 500,500` displays feedback without clicking or moving the hardware pointer.

Prepared fingerprints also bind browser chrome to the active document URL. A Reload button or address bar observed on one page cannot silently rebind on another page. Repeated unnamed controls include bounded neighboring static text in their fingerprint; identical rows remain ambiguous. The Jev chooser receives the same nearby text when its observed scope includes the enclosing row. For lists, use `within_ref` on that row so unrelated controls and page content stay out of the decision.

Unnamed static text uses its visible text as its label. A browser status can therefore use exact readback such as `exact:{label:"0 items left!",role:"AXStaticText",value:"0 items left!"}` without a model request. Do not assume that a browser checkbox's `AXSelected` means checked; verify the state it actually exposes or another explicit status.

Control refuses new native commands while the shared GenesisTools.app build lock exists. This avoids running against a bundle being replaced or accidentally dropping to an unwrapped executable during installation. A refusal does not remove the lock or alter permissions. Native permission errors include the responsible process's PID, bundle ID and executable path for diagnosis.

Snapshot actions refuse targets behind a visible native sheet or an explicitly modal AX container. Coordinate actions must remain inside its bounds, and semantic selection excludes blocked controls even after query narrowing. This does not automatically approve or dismiss a dialog: inspect the modal and choose an authorized action within it. If the native bulk reader omits a required element role, observation falls back to the per-attribute AX walk instead of exposing empty alert controls. This fixes the Software Update alert case where the fast read lost both its message and OK button.

A full native Brave → new tab → Google → weather search → Jev-selected forecast → page readback completed in 11.2 seconds on the three-display setup. This is a successful measured rerun after fixing the earlier failures, not a claim that the initial attempt was that fast.

## MCP configuration

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "tools",
      "args": ["computer-use", "mcp"]
    }
  }
}
```

Use `["computer-use","mcp","--repl"]` for the four node-repl-compatible tools (`js`, `js_reset`, `js_add_node_module_dir`, `turn_ended`) with `computer` preloaded. The native tool server and REPL server use the same API implementation; each server owns its own state.

The native performance harness is `bun src/control/scripts/live-smoke.ts --background-only --benchmark`. It creates its own disposable app and compares the duplicate-read baseline against reuse of the native action refresh. Both paths verify every write; the result contains interleaved samples, child CPU, native call counts and elapsed time.

## Verification and current limits

`bun src/control/scripts/live-smoke.ts --background-only --computer-api` creates a disposable native app, briefly focuses it for keyboard/paste checks, restores the prior foreground app when appropriate, and tests the API, a separate stdio MCP process, and two persistent REPL cells. It uses neither Codex nor Sky.

The backend needs the existing GenesisTools launcher permissions for Accessibility and Screen Recording. First-use compilation can take longer than an ordinary action deadline; prepare first. Key chords accept comma or plus separators, modifier aliases, navigation keys (Home/End/Page_Up/Page_Down/ForwardDelete), F1–F20 and keypad names such as KP_Enter. Letter and punctuation keys use macOS virtual key positions; use type_text for layout-independent Unicode. Delete is the Mac backspace key; ForwardDelete deletes ahead.

Native `AXPopUpButton` fields use their observed AXPress menu. `set_value` and `fill_form` choose one exact, enabled menu-item title and require the selected value to read back exactly. Duplicate, missing or disabled options stop the operation; an unselected menu is dismissed through its exposed AXCancel when available. Arbitrary custom web dropdowns are not covered by this native contract. Structured fills also stop when an observed field exposes `AXInvalid`; applications that omit that attribute need a separate explicit validation check.

`bun src/control/scripts/live-smoke.ts --background-only --dropdown` proves native selection, readback and missing-option refusal. Add `--semantic` to test public Jev form mapping too. This probe disables cursor feedback so animation cannot invalidate its later screenshot-bound checks; `--cursor-proof` separately exercises cursor animation.

## Fast sequences and OCR

`press_sequence` uses one native process for a generic role/root-role target set. It requires explicit `jev:true`, admits the observed set once per window, then performs and verifies the bounded native sequence. It shares a 200-action cap and a whole-run deadline; unknown delivery stops the run.

```ts
await computer.press_sequence({
    app: "com.brave.Browser",
    intent: "Activate each tab in the observed browser tab group",
    role: "AXRadioButton",
    rootRole: "AXTabGroup",
    windowIds: [state.window.id],
    verifyAttribute: "AXSelected",
    restoreSelected: true,
    focus: true,
    provider: "typesafe",
    jev: true,
});
```

For OCR, observe with `perception:"ocr"`. The returned `visual.regions` carry revision-bound refs. `resolve_visual_target` defaults to exact text matching; selecting Jev or Auto explicitly enables one Jev request. Pass its `region_ref` to `click`. Native code checks the captured pixels and consumes that evidence once.

```ts
await computer.get_app_state({app:"Example App", window_index:0, perception:"ocr"});
const target = await computer.resolve_visual_target({
    app:"Example App", intent:"Open preferences", chooser:"jev", provider:"vercel",
});
if (target.region_ref) {
    await computer.click({app:"Example App", region_ref:target.region_ref});
}
```

SDK screenshots are temporary: replacing a state's image or closing its session removes the previous owned file. The REPL parent owns its worker's capture directory and removes it on reset, timeout, disposal or worker exit, including a worker that cannot run cleanup itself. Copy an image explicitly if it needs to outlive the current state.

Local live checks on 18 Sep 2026: one standalone REPL call visited and verified 82 Brave tabs in two windows in 21.1 seconds, then restored each original selection. A separate OCR capture/Jev-choice/native-click call completed in 1.9 seconds. These are individual observed runs, not latency guarantees.

## Automatic guard recovery

Prepared element actions automatically retry admission after a confirmed native `not_started`
stale-observation or focus refusal. The original snapshot and target fingerprint remain pinned,
including field values and document URL. Two retries at most may start within 1.5 seconds of the
first refusal; each attempt and its readback use the remaining original caller deadline. The
result's `recovery` contains retry count, refusal categories and
elapsed time. No workflow restart or additional Jev decision is needed.

Missing/ambiguous targets, changed values/documents, modal barriers, permission failures, coordinate
clicks and unknown/already-dispatched input do not qualify. In particular, failed paste readback
never causes another paste. Unstable screenshot observations can separately retry twice within a
one-second budget, including post-action readback, without repeating input. Successful observation
recovery is reported in `state.observationRecovery` or the returned observed state.
