# Bug to Test

The product is a native macOS recording, review and verification window backed by the `bug-to-test` CLI. Its core lives in `src/bug-to-test/lib`. Browser attachment and action capture live in `src/chrome-devtools/lib/action-recording.ts`, using the existing bounded CDP `Conn`, target inventory and local debugger URL checks.

## Recording and privacy

Choose an installed browser and enter an optional website URL, then click **Open recording browser**. The app opens a fresh separate profile, fills its endpoint automatically and lists its HTTP tabs. Navigate and sign in inside that window if needed, then refresh and select the exact tab. Existing browser windows and profiles stay open. The optional debugging port is for attaching to an existing endpoint.

The same typed browser setup is available through `tools bug-to-test browsers`, `tools bug-to-test open-browser --browser chrome --url http://localhost:3000` and port-optional `tools bug-to-test tabs`. Startup waits at most 30 seconds. Cancelling startup terminates only its owned process. Opening the browser does not start a recorder; recording begins after selecting a tab and clicking Record.

Capture is scoped to the exact selected HTTP tab. Trusted click, change, Enter/Escape/Tab and main-frame navigation events become data records. Locators prefer unique test IDs, then role/name, then unique CSS. Each action carries its source URL and the target's tag, derived role and name fingerprint. Replay checks count, visibility, enabled state and captured target identity before dispatch.

Password, file and credit-card fields become warnings without values. Plain text credential fields are also omitted when their id, name, test ID, accessible name or autocomplete plainly indicates password, secret, token, API key, credential, card, CVV or CVC. Capture retains response status/URL summaries, failed requests, console output and navigation. It does not capture request bodies, cookies, authorization headers or browser storage. Common bearer tokens, credential query parameters and named credential assignments are redacted. Review the captured data before export; arbitrary private content in ordinary form values, DOM labels and console text still requires the user's review.

The recorder is bounded to 200 actions, 500 evidence entries and at most 600 seconds. The native window records for 300 seconds. Every CDP call has a deadline. Stop removes the binding, injected scripts, event listener and debugger connection. Each session atomically claims a per-tab nonce and uses its own binding name. A second session refuses an existing owner; cleanup cannot replace or stop a different recorder. Repeated Stop calls share one cleanup promise. A stale marker requires an explicit tab reload. The target browser is left running.

Frames, canvas gestures, drag-and-drop, arbitrary keyboard shortcuts and multi-tab flows are not reconstructed. Unsupported or unstable targets must be adapted manually in a reviewed exported test. A fresh browser context will not recreate a signed-in private profile; supply appropriate local fixtures or explicit login steps when the bug depends on that state.

## Assertions and execution

The expected behavior is explicit text plus one structured assertion. Supported assertions are exact text, exact form value, visible/hidden and exact HTTP URL. Empty descriptions/values, invalid assertion kinds, invalid locators and ambiguous visibility values are rejected. Value assertions preflight that the target is a form control.

Hidden assertions accept an absent element or one hidden element. They reject multiple matches as an infrastructure error. Text, value and visible assertions require exactly one match. A deletion that removes the target can therefore turn the same hidden assertion green.

The generated test uses Playwright's ordinary `test` and `expect`. Action and target preflight errors have separate messages. Only a single failed test whose error starts with the exact `BUG_TO_TEST_EXPECTATION` matcher message can be classified as the intended bug. A marker appearing inside a selector or a browser disconnection cannot satisfy this gate. Missing reports, unexpected exit codes, timeouts and cancelled work remain separate outcomes.

Workspaces are explicit generated directories. The source hash, deterministic source, Playwright configuration and frozen TypeScript configuration must match before native execution. Native execution uses only GenesisTools' installed dependencies; imported dependencies or module aliases are refused. Imported recordings are schema-validated data, never scripts.

Execution uses Node.js and a fresh Playwright context. It has a thirty-second outer deadline, twenty-five-second suite deadline, fifteen-second test deadline and 1.5-second expectation deadline. Cancellation signals the owned process group and escalates after 1.5 seconds even when the leader already exited. It waits for termination and a bounded group-exit check before returning. Each run gets a separate `runs/<id>` directory so a green rerun retains earlier failing traces.

Minimization protects the selected trigger action. Each proposed removal is accepted only after another intended assertion failure. It makes at most twelve attempts within a ninety-second search budget, plus the bounded in-flight check. It retains the original recording and names removed action IDs. This is a bounded reduction, not a claim of a mathematically smallest repro.

## Persistence and export

The native window autosaves its reviewed JSON under the application's support directory and exposes the saved path. Save/Open/Recover restore actions, exclusions, redactions, assertion, trigger and generated workspace metadata. Changes invalidate prior verification; a new assertion requires a new generated workspace. Rerun executes the same frozen source.

Export includes the portable source/config/package, reviewed recording, reports, traces, run logs and selected ordinary local fixture files. It excludes `node_modules`, rewrites artifact paths into the bundle and refuses symlinked evidence. Selected fixtures are inspectable inputs; the exporter never executes them automatically. The exported README explains normal npm/Playwright installation and deployment remapping. No GenesisTools import appears in generated test code.

## Verification

Cheap contract checks:

```sh
bun run test src/bug-to-test/lib/core.test.ts
cd src/macos/GenesisTools
swift test --filter BugToTestTests
```

The actual acceptance harness deliberately launches an isolated headless Chromium profile and an invented localhost shop. It records real browser clicks plus console/network evidence, verifies the expected count fails, verifies a missing selector is infrastructure, removes a theme click while retaining the Add trigger, exports and independently installs a bundle, starts the exported local fixture in a fresh process, verifies red, fixes the fixture and verifies green with unchanged source, checks deletion with an unchanged hidden assertion plus a duplicate-selector control, then cancels an active owned run. The core suite also exercises a real TERM-resistant descendant whose leader exits first, with ordinary completion as a control.

Run it with an explicit evidence folder:

```sh
bun src/bug-to-test/scripts/acceptance.ts /absolute/evidence/folder
```

The harness uses the installed Google Chrome executable on macOS. It does not attach to a user's live browser or read a private profile. Its JSON receipt and raw Playwright reports/traces are the proof; browser tests are opt-in and are not added to the routine CI suite.

The app can render an offscreen native layout using `GenesisTools --bug-to-test --open recording.json --snapshot image.png --pane actions|evidence|source|trace`. This checks layout without activation. Signed desktop interaction remains a separate acceptance gate.
