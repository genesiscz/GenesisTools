# Native control playbooks

Use the shared `computer` object in `tools computer-use run --file task.ts --json` or the
repository's persistent REPL. All examples require freshly observed targets; sample labels
are not permission to operate an unrelated window. Show the concrete script before executing
when the user asks for a demonstration. Feedback is enabled by default. The native backend
treats `GENESIS_CONTROL_CURSOR=off` as disabled; `GENESIS_CONTROL_CURSOR=on` overrides an
inherited off value. Do not pass `--no-cursor`. Foreground the intended window deliberately.

## 1. Discover windows without activating them

```ts
const app = "com.brave.Browser";
const inventory = await computer.list_windows({ app });
nodeRepl.write(inventory.windows);
```

Choose a unique regular, non-minimized window using its current title and `window_id`.
Never assume the first window is the user's intended one. A window's active title can change
while its desired tab remains open. For an existing browser tab, inspect `scope:"chrome"`
and match its `AXRadioButton` label. A story number may also occur in a merge-request title:
use the requested title/type, not a bare substring or a remembered index.

`get_app_state({app, window_id, scope:"chrome", image:false})` is the fast browser-chrome read.
Use `scope:"window"` for page links/forms. `element_limit` controls returned rows, not native
tree traversal. `get_elements` pages a retained observation; `find` searches its full rows.
Do not pass `text_limit` to `get_app_state`. A closed/offscreen window, oversized native tree
or cancelled read requires fresh discovery/narrowing, not a claim that the app has no content.

## 2. Draft a URL, verify it, restore it

Before running, replace `wantedTitle` with a title observed in the discovery step. This example
requires one existing Example Domain tab. It never presses Return or submits the address.
The supplied draft stays in local code; Jev receives only the bounded field decision.

```ts
const app = "com.brave.Browser";
const wantedTitle = "Example Domain";
const draft = "https://example.com/control-preview";
const signal = AbortSignal.timeout(30000);
const inventory = await computer.list_windows({ app, signal });
const windows = inventory.windows.filter(
    (w) => w.window_id && !w.minimized && w.title?.includes(wantedTitle)
);
if (windows.length !== 1) {
    throw new Error("Choose one current window explicitly.");
}
const window_id = windows[0].window_id;
const observe = () => computer.get_app_state({
    app, window_id, scope: "chrome", image: false, signal,
});
const address = (state) => state.elements.filter(
    (e) => e.role === "AXTextField" && e.label === "Address and search bar"
);
const normal = (value) => String(value ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
let state = await observe();
const fields = address(state);
const original = fields.length === 1 ? fields[0].value : undefined;
const originalURL = state.document?.url;
if (typeof original !== "string" || !originalURL || normal(original) !== normal(originalURL)) {
    throw new Error("Ambiguous address or existing draft; preserve it.");
}
const chosen = await computer.resolve_target({
    app, action: "set", query: "Address and search bar", role: "AXTextField",
    intent: "Select the browser address field for a temporary draft, without navigating.",
    chooser: "jev", provider: "typesafe", signal,
});
if (!chosen.ref) {
    throw new Error("Jev abstained; no write.");
}
try {
    const result = await computer.paste({
        app, element_ref: chosen.ref, text: draft, replace: true, prepare: true, signal,
    });
    if (!result.ok) {
        throw new Error(result.error);
    }
    state = await observe();
    if (address(state)[0]?.value !== draft || state.document?.url !== originalURL) {
        throw new Error("Exact replacement or unchanged document did not verify.");
    }
} finally {
    state = await observe();
    const current = address(state);
    if (current.length === 1 && current[0].value === draft && state.document?.url === originalURL) {
        const restored = await computer.paste({
            app, element_ref: current[0].ref, text: original,
            replace: true, prepare: true, signal,
        });
        if (!restored.ok) {
            throw new Error(restored.error);
        }
    }
}
state = await observe();
if (normal(address(state)[0]?.value) !== normal(original) || state.document?.url !== originalURL) {
    throw new Error("Restoration is not verified; do not overwrite further user input.");
}
nodeRepl.write({ verified: true, restored: true, navigated: false, jevRequests: chosen.metrics.requests });
```

Why this contract exists: plain paste inserted a draft before the existing address, producing
`https://example.com/previewexample.org/page`. Double-click only selects a word in many fields.
`prepare:true` focuses a field; it does not mean select-all. `replace:true` requests select-all
and exact native readback, and requires preparation. `set_value` can also replace directly,
but Escape may leave such an AXValue write intact. Restore the captured original explicitly.
If cleanup finds changed user text or a different document, stop and report instead of overwriting it.

## 3. Handle a blocking sheet before navigation

The Software Update incident exposed two separate issues: a modal blocked the sidebar, and
bulk AX returned its children with empty roles and zero geometry. The normal AX walk exposed
the actual error text and OK button. The backend now rejects that incomplete bulk structure
and falls back to normal AX reads; `bulk:false` in native output is a legitimate result, not loss of functionality.

Diagnosis is read-only:

```bash
bun src/control/index.ts see --app com.apple.systempreferences --window-id OBSERVED_ID --no-image
AX_TOOL_NO_BULK=1 bun src/control/index.ts see --app com.apple.systempreferences --window-id OBSERVED_ID --no-image
```

Compare required roles, labels and geometry; don't treat blank child rows as a complete tree.
If AX still omits the blocker, inspect the exact window screenshot/local OCR. Do not guess an
OK coordinate from another capture. Snapshot actions reject controls outside a visible sheet
or explicit `AXModal` container; coordinate actions must remain within its bounds. Semantic
admission excludes covered controls even when `query` or `within_ref` narrows the tree.

After the user has authorized acknowledging the particular informational error, use its subtree:

```ts
const app = "com.apple.systempreferences";
let state = await computer.get_app_state({ app, window_id: observedWindowId, image: false });
const sheets = state.elements.filter((e) => e.role === "AXSheet");
if (sheets.length !== 1) {
    throw new Error("Inspect the actual modal before choosing an action.");
}
const choice = await computer.resolve_target({
    app, within_ref: sheets[0].ref, role: "AXButton", query: "OK",
    intent: "Acknowledge this observed download-error alert without starting an update.",
    chooser: "jev", provider: "typesafe",
});
if (!choice.ref) {
    throw new Error("No admitted acknowledgment.");
}
const result = await computer.click({ app, element_ref: choice.ref });
if (!result.ok) {
    throw new Error(result.error);
}
state = await computer.get_app_state({ app, window_id: observedWindowId, image: false });
if (state.elements.some((e) => e.role === "AXSheet")) {
    throw new Error("Dialog dismissal is not verified.");
}
```

This is not a general “click OK on every dialog” policy. Installs, permissions, authentication,
destructive confirmations and external submissions need their own authorization. Read the
message, not just the button. Reobserve the background pane after dismissal before navigating.
`AXRaise` failure can be a symptom of a blocking sheet; repeated focus attempts are not a cure.

## 4. Disambiguate meaning before spending a request

Use the actual domain context already present in the tree:

- Browser tabs: requested document kind plus title, not just an issue number.
- Page links: `label`, observed `url` and enclosing heading. The React and TypeScript Source
  links are different candidates even though both display “Source”.
- Update details: find `PrimaryUpdates.Header`, then resolve `Info` with `within_ref` on that
  group. Never confuse Info with Upgrade/Update controls or the secondary update's Info.
- Repeated row checkboxes: scope to the intended row. Native fingerprints bind bounded
  neighboring text; indistinguishable rows still refuse.

Prefer the existing `resolve_target` API over an ad-hoc classifier that sends only a goal and
flat labels. Preserve roles, surrounding evidence and uncertainty. Do not repeatedly ask the
same ambiguous question. If a host can prove one exact requested match independently, act on
that fresh match and label the result as host-selected; do not relabel Jev's abstention.
An AX static-text row may expose an internal component identifier as its normalized label;
retain its readable value and parent context too. A bundle-like Settings identifier by itself
is poorer semantic evidence than the visible category name. Do not rename a failed model choice
as successful merely because an exact host action subsequently worked.

## 5. Form, readiness and host-handoff examples

```ts
const fill = await computer.fill_form({
    app: "com.example.App", window_id: observedWindowId,
    data: { Name: "Example Person", Priority: "High" },
    jev: true, provider: "typesafe", timeout_ms: 15000, max_fields: 2, max_requests: 2,
});
nodeRepl.write(fill);
```

Check `fill.status === "filled"`; exact readback and exposed `AXInvalid` govern continuation.
Native popups select unique exact enabled option titles. Values stay local, fields are not
reused, and there is no submit. Missing/duplicate options and custom unsupported widgets stop.

```ts
await computer.get_app_state({ app: "com.example.App", window_id: observedWindowId, image: false });
const ready = await computer.await_condition({
    app: "com.example.App", condition: "Saved",
    exact: { identifier: "save-status", value: "Saved" },
    max_requests: 0, timeout_ms: 5000,
});
nodeRepl.write(ready);
```

For a semantic condition use `jev:true` and `evidence_scope:{identifier:"export-panel"}` or
an exact label plus optional role. An outside changing clock then causes no paid requests.
Without scope the full observed window supplies evidence. Missing/ambiguous scope stops;
no automatic widening. Stable state reuses the judgment without extending the deadline.

`resolve_target`/`assist_task` accept `host_decision:{packet,answer}` from an earlier escalation.
Repeat the original intent/scope. Fresh scope/candidate/evidence/expiry/conflict validation
runs without another model call. Do not manufacture a packet or edit it to fit changed UI.

## 6. Visible demos and honest measurements

Creating a window is asynchronous. After sending the shortcut once, wait within a deadline for
one new regular window ID relative to the pre-action inventory. Do not assume the first listing
contains it, and do not repeat the shortcut when readback is inconclusive. If a new window closes,
discard its refs. Navigation may temporarily invalidate the AX tree; reobserve within the deadline
and check the exact destination before continuing. A failed navigation readback does not authorize
resending Return or pasting the URL again.

Prepared actions revalidate the same unique target/document fingerprint after cursor presentation;
unrelated window changes must not invalidate that explicit binding. Target value changes, replaced
elements, modal coverage and lost input focus still refuse. Unprepared actions retain whole-tree
checks, and coordinate actions retain fresh pixels. If a web input fails paste readback, inspect
fresh state before deciding anything else. A later explicit click on an observed empty field may
establish input focus; it is a new observed action, not permission to repeat an uncertain paste.

Use one script or persistent REPL and one overall deadline. Precompile first and measure that
as preparation. Keep `GENESIS_CONTROL_CURSOR=on` and `GENESIS_CONTROL_CURSOR_WAIT=required`, foreground the intended window, and allow a
short deliberate presentation pause after verified results. Separate that pause from execution
and Jev time. Required mode waits at most 1.5 seconds for an event-specific presentation receipt;
timeout or disabled/missing target feedback stops input. The helper waits for glide completion
and two display callbacks, then its display link stops. A receipt does not verify the app result;
use a region recording when the claim concerns actual pixels. Snapshot/menu/pointer guards run
again after waiting. Drag movement does not wait per sample.

Calculator needs a known initial expression: Clear can clear only the current operand;
use an observed All Clear to reset a pending expression. Verify the result inside the Edit
field subtree, not any historical expression. Normalize only known directional formatting
marks/locale presentation; never strip arbitrary text until it happens to equal the answer.

Read every inner task result, not just the runner envelope. Preserve the first attempt, failed
readbacks, model abstentions, unknown dispatch and corrected reruns. A task's `wallMs` includes
observation, model, dispatch and verification; report presentation pauses separately. Report
preparation and investigation time when measured, otherwise mark it unmeasured. Do not present
the sum of successful reruns as the elapsed time since the request.

## Bounded recovery without restarting the task

Prepared element calls now recover inside the shared native runner after a typed `stale_observation`
or `focus_mismatch` refusal with `dispatchState:"not_started"`. Both the CLI and async API retain
the original token and target fingerprint. The backend reobserves, uniquely locates that fingerprint,
prepares again and runs every normal guard. At most two retries may start within 1.5 seconds of
the first refusal. Every attempt, including readback, shares the original caller deadline; the
retry window does not kill a paste that has started. Successful calls report `recovery.retries`, `refusals` and
`elapsedMs`; workflow traces retain this receipt. No extra Jev request is made.

This is not semantic rebinding. Changed values, documents, missing/ambiguous targets, modal barriers,
permissions and expired tokens still stop. Coordinates and OCR regions are not retried. Unknown or
already-dispatched input never qualifies, including native crashes/timeouts. A failed paste readback
cannot trigger a second paste. Replacement readback waits for the exact requested text, not the
first intermediate value change, while keeping the clipboard available. `noRetry` in workflow
plans still forbids replaying dispatched steps.

Unstable AX/screenshot reads retry up to twice in the same pinned process/window within a one-second
read budget. This also repairs `act --refresh` observations without repeating the action. Permanent
read errors still surface. Successful read recovery appears as `observationRecovery.retries`.

The fixture's opt-in recovery input deliberately deflects its first AX focus request. This tests an
actual native refusal, then verifies exactly one text-change event and an untouched decoy field:

```bash
GENESIS_CONTROL_CURSOR=on GENESIS_CONTROL_CURSOR_WAIT=required \
  bun src/control/scripts/live-smoke.ts --guard-recovery
```

## 7. Focused verification commands

```bash
bun src/control/scripts/live-smoke.ts --background-only --dropdown
bun src/control/scripts/live-smoke.ts --background-only --dropdown --semantic
bun src/control/scripts/live-smoke.ts --background-only --computer-api
bun src/control/scripts/live-smoke.ts --cursor-proof
GENESIS_CONTROL_CURSOR_WAIT=required bun src/control/scripts/live-smoke.ts --cursor-proof
bun src/control/scripts/live-smoke.ts --task-benchmark
bun src/control/scripts/live-smoke.ts --task-benchmark --host-paced
bun scripts/test.ts src/control src/jev src/utils/ai/evaluation
swift test --package-path native/ax-tool
```

Choose the mode relevant to the change; don't run all of them reflexively. `--semantic`
explicitly spends Jev requests. The dropdown arm disables feedback for its screenshot checks;
it is not a visible cursor demonstration. The cursor-proof arm records foreground actions;
review the contact sheet or video. Coordinate pixel refusal can also happen with feedback off:
retain before/after evidence and don't blame the overlay without proof. A live test can still
be interrupted by another foreground user/process, and unknown delivery must not be retried.

`--task-benchmark` explicitly spends TypeSafe Jev requests on interleaved native tasks. Both
stepwise and compound arms verify the same exact state; setup/reset is outside measured time.
The first pair is retained but excluded from the warm summary. `--host-paced` runs one pair
with actual stdin `next` dispatches from the host, and includes those waits in wall time.
It is a bounded orchestration comparison, not a simulated latency estimate or a comparison
against a prohibited external computer-use runtime. Keep failed arms; never retry an uncertain mutation.
