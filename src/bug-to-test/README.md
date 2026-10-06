# Bug to Test

Bug to Test records a browser bug and turns a user-defined assertion into an ordinary Playwright test. Open its native window from the Hub's File menu, **Bug to Test…**. The signed application also accepts `--bug-to-test` and `--bug-to-test --open recording.json`.

Select an HTTP tab from a local Chromium debugging endpoint, record the bug, then stop. Review the captured actions and browser evidence. Exclude irrelevant entries and edit private input/evidence text before generating. State the expected behavior and an exact text, value, visibility or URL assertion. The target must resolve uniquely.

**Generate and verify** creates an isolated workspace and actually executes the Playwright assertion in a fresh browser context. **Bug reproduced** means that exact matcher failed; selector errors, missing dependencies, closed browsers and deadlines have separate outcomes. The window shows the source, assertion failure, source hash, report and trace. Its trace viewer runs on localhost for at most two minutes.

Select the recorded trigger before minimizing. Minimization retains it and removes other actions only after observing the same assertion failure. It is bounded to twelve candidate checks and a ninety-second search budget. Each execution preserves its own report, trace and runner log under `runs/`.

**Export repro** writes a portable Playwright package, reviewed recording/evidence, run history and selected local fixture files. It excludes the internal dependency symlink and private browser cookies/storage. In the exported folder:

```sh
npm install
npx playwright install chromium
npm test
```

Set `BUG_TO_TEST_BASE_URL` to rerun against a fixed deployment. `BUG_TO_TEST_BROWSER` optionally selects an installed Chromium binary. In the native window, enter the fixed base URL and use **Rerun same assertion**. The source hash must remain unchanged.

Recordings autosave on this Mac. **Save recording…** saves a portable JSON review document; **Open…** and **Recover local recording…** restore it. Editing any assertion or recorded evidence invalidates the prior verified workspace/result. Reopened executable workspaces must still match the deterministic generator and frozen configuration; imported recording JSON never executes supplied code or module aliases.

For the complete contract, limits and acceptance harness, see [docs/bug-to-test.md](../../docs/bug-to-test.md).

## CLI

The CLI is the same core used by the native window:

```sh
tools bug-to-test tabs --port 9222
tools bug-to-test record --port 9222 --tab TARGET_ID --output recording.json --stop stop-file
# Create stop-file after reproducing the bug, then review the JSON and add expectation.
tools bug-to-test inspect --input recording.json
tools bug-to-test generate --input recording.json
tools bug-to-test verify --workspace GENERATED_DIRECTORY --browser /path/to/chromium
tools bug-to-test minimize --input recording.json --browser /path/to/chromium
tools bug-to-test export --workspace GENERATED_DIRECTORY --destination NEW_FOLDER --fixture fixture.json
tools bug-to-test trace --workspace GENERATED_DIRECTORY
```

No AI requests are made. Node.js and installed Playwright dependencies are required for execution. A Chromium binary or installed Playwright Chromium is required. The recorder uses the existing `src/chrome-devtools/lib` connection and target discovery.
