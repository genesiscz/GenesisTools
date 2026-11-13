# tools e2e

Runs a project's end-to-end specs one runner process per spec file and collects the results, screenshots and logs
into one run folder. It drives WebdriverIO with Appium on an iOS simulator for a mobile app, and Playwright Test for a
web site. The tool owns the run (spec discovery, the processes, the run folder, the summary); the project owns its
specs, page objects, runner config and hooks. Use it when you want one command that runs a spec set, tells you what
failed, and keeps every log beside the failure.

## Quick start

```bash
tools e2e config                          # the e2e project this folder resolves to
tools e2e list                            # spec files and named suites
tools e2e run login --udid <udid>         # a spec name, a path, or a word in the name
tools e2e suite smoke --env API_URL=http://127.0.0.1:3143   # a named suite, with a variable for each spec
tools e2e screen agents --udid <udid> --expect screen-agents  # one app screen, checked without a spec
tools e2e report                          # the latest run's summary
```

Every command reads the project's `e2e.config.ts` (see [Configuration](#configuration)). Run it from the project
folder, or pass `--config <file>`.

## Commands

Every command takes `--config <file>`: the project's `e2e.config.ts`. Without it, the tool takes the nearest
`e2e.config.ts` or `e2e/e2e.config.ts` at or above the working folder. The tool also takes `-v, --verbose` and
`--readme`.

### Look at the project

```bash
tools e2e config [--json]
tools e2e list [--json]
```

- `config` shows the project id (or `title`), the runner, the config path, the folder runner processes start in, the
  spec and page folders, and the names of the suites and hooks.
- `list` shows every spec file (its name and its path), the page folder, and each named suite with its members. It
  warns when the spec folder holds no spec.

### Run specs

```bash
tools e2e run <specs...> [options]        # these specs, in the order you name them
tools e2e suite [name] [options]          # a named suite in its own order; no name runs every spec
```

`run` and `suite` take the same options:

| Option | What it does |
|---|---|
| `--env <pair>` | `KEY=VALUE` for every spec process; repeat it for each variable |
| `--out <dir>` | the run folder; default `~/.genesis-tools/e2e/runs/<project>/<time>` |
| `--stream` | print the runner's output while it runs |
| `--json` | print only the summary, as JSON |
| `--udid <udid>` | wdio: the simulator; default the only booted one |
| `--appium-port <port>` | wdio: the Appium server; default the simulator's own, started when missing |
| `--no-alert-watcher` | wdio: do not answer system alerts during the run |
| `--base-url <url>` | playwright: the site under test; default `runner.baseUrl` |

A runner reads only its own flags, so a `wdio` project ignores `--base-url` and a `playwright` project ignores the
simulator flags.

How a name picks specs:

- An exact spec name or a path relative to the config's folder wins. The name is the file name without its suffix:
  `login` for `login.spec.ts` (the suffixes `.spec`, `.test` and `.e2e` with `.ts`, `.tsx`, `.js`, `.mjs` and the
  like are stripped).
- Otherwise every spec whose name contains the word runs. `tools e2e run flow` runs `pairing.flow` and `agents.flow`.
- A name that matches nothing is an error that lists every spec. A spec named twice runs once.
- `suite` with no name, or `suite all`, runs every spec. `all` is reserved: a suite of that name in the config never
  runs.

While it runs, the tool prints one line per spec (`2/5 login`), then its result (`login: 3/4 passed in 41 s`) and the
first line of each failed test's error. The last lines are the counts and the path of `summary.md`. The command exits
1 when the run failed.

### Check one screen of a mobile app

```bash
tools e2e screen <route> [options]
tools e2e screen agents --udid <udid> --expect screen-agents --expect agents-list
```

`screen` opens one screen of the app without a spec, checks it, and saves a capture. It fails when the route's root
never shows (only for a route with a root id), an expected testID is missing, a LogBox covers the screen, or a system
alert is open.

| Option | What it does |
|---|---|
| `--mobile <file>` | the app's `mobile.config.ts`; default below |
| `--udid <udid>` | the simulator; default the only booted one |
| `--appium-port <port>` | the Appium server; default the simulator's own, started when missing |
| `--expect <id>` | a testID that must be on the screen; repeat it for each |
| `--out <dir>` | the capture folder; default `~/.genesis-tools/e2e/runs/<project>/<time>` |
| `--json` | print the result as JSON |

- `<route>` is a route name from the app's `mobile.config.ts` (`tools mobile routes` lists them), a name with a query
  (`agents?tab=all` adds `tab=all` to the route's link), or a whole link with a scheme (`myapp://agents`).
- The app config is `--mobile` (a relative path is read from the working folder), else `runner.mobile` of a `wdio`
  project (read from the e2e config's folder), else the nearest `mobile.config.ts` or `e2e/mobile.config.ts` at or
  above the e2e config.
- It opens the route through Appium's `mobile: deepLink`, so iOS shows no "Open in ...?" alert. For a route with a
  root id it waits up to 15 s for that root element. Then it waits 1.5 s more for the screen to settle.
- A whole link has no root to wait for, so only `--expect`, LogBox and alerts are checked. A route in
  `mobile.config.ts` without a `rootId` is not checked for a root either.
- It attaches to the installed app with `noReset` and leaves the app on screen when it closes the session.
- The capture is `<route>.png`, `<route>.xml` (the raw accessibility tree), `<route>.tree.txt` (one line per element
  with a testID, words or a tap target) and `<route>.json` (the summary). For a whole link the files are `link.png`,
  `link.xml`, `link.tree.txt` and `link.json`. The command prints the tree and screenshot paths and the first 20 texts
  on the screen.

### Read results

```bash
tools e2e report [run] [--json]
tools e2e compare [before] [after] [--json]
```

- `report` prints a run's `summary.md` (or `summary.json` with `--json`). `[run]` is `latest` (the default),
  `previous`, a stamp under the project's runs (`2026-11-04T21-05-33`), or the path of a folder that holds a
  `summary.json`. It exits 1 when that run failed.
- `compare` names every test whose state changed between two runs, new failures first, then fixed tests, then the
  rest. The defaults are `previous` and `latest`, and each run takes the same forms as `report`. A test is matched
  by its Playwright project, spec path, suite and title; when one of them repeats in a run, a failure wins. A state is
  `passed`, `failed`, `skipped` or `absent`. It exits 1 when a test fails in the newer run that did not fail in the
  older one.

`latest` and `previous` count only finished runs under `~/.genesis-tools/e2e/runs/<project>/`: folders that hold a
`summary.json`. A `screen` capture and a run that stopped before its summary never count. A run you sent elsewhere
with `--out` is found only by its path.

## How it works

### One run, step by step

1. The tool loads the project config and picks the specs. Two picked specs with one name (`a/login.spec.ts` and
   `b/login.spec.ts`) are refused before anything starts, because their artifacts would overwrite each other.
2. It creates the run folder. The folder must not exist yet, so two runs never share one and old results never mix
   in.
3. The runner prepares its target: the simulator and its Appium, or the site.
4. The project's `beforeRun` hook runs.
5. Each spec runs as its own runner process in the project's `cwd`, one after another. Its output goes to
   `runner.log` in the spec's folder. A spec process runs at most 30 minutes; then the tool stops its whole process
   group and the spec fails.
6. The runner stops what it started beside the specs (the device log, the alert watcher) and copies its side files.
7. The project's `afterRun` hook runs with `ok`. It runs even when `beforeRun` threw, but not when step 3 failed.
8. The tool writes `summary.json` and `summary.md`.

A spec fails when its runner exits non-zero, a test fails, or it reported no test. A run passes when it ran at least
one spec, no spec failed, and the teardown (step 6 or 7) did not throw. When `afterRun` throws, the command fails with
that error, and `summary.json` is still written with `ok: false`. If the tests had passed, the summary also gets the
note "Run teardown failed; see the command error.". When the runner's cleanup in step 6 throws, the command fails with
that error and no summary is written, as when `beforeRun` throws. When `beforeRun` throws, no spec runs.

### The runners

`runner.kind` picks one runner from the `RUNNERS` table (`src/e2e/lib/runners/`). A new runner is one file and one
entry there.

**`wdio`: WebdriverIO with Appium on an iOS simulator.**

- The app comes from the project's `mobile.config.ts` (`runner.mobile`, or the nearest one upward; see
  [tools mobile](../mobile/README.md)). The app must be installed on the simulator already; the tool never builds it.
- The simulator is `--udid`, or the only booted one. With several booted, it refuses to guess, because it could drive
  (and maybe reboot) another session's simulator.
- Each simulator has its own ports from a hash of its udid: Appium 4900 to 4999, WebDriverAgent 18100 to 18999 and
  MJPEG 1000 above that. Two runs on two simulators never kill each other's WebDriverAgent.
- When no Appium answers on the port, the tool starts its own (`appium` on `PATH`, else `bunx --yes appium`, run from
  the temp folder). That server stays up after the run for the next one; `tools mobile appium stop --udid <udid>`
  stops it. Its log is `~/.genesis-tools/mobile/appium/<port>.log`.
- Each spec runs `bunx wdio run <config> --spec <file>`.
- Beside the specs it keeps `device.log` (the app's process log from `xcrun simctl spawn <udid> log stream`),
  `appium.log` (the server's lines during this run, at most the last 16 MiB) and `alerts.jsonl` (the system alerts the
  watcher answered or left).
- The alert watcher checks every 1.5 s for a known system alert of the app under test: "Open in ...?", notifications,
  local network, location, tracking, camera and other access prompts, and "Save Password?". It answers alerts of the
  app under test only, with two exceptions: it taps Cancel on an "Open in ...?" alert that names another app (another
  build of the same scheme), and it taps Not Now on any "Save Password?". It never touches the app's own alerts, so a
  spec can still assert on a confirmation dialog. Until the first session
  brings up WebDriverAgent it reads alerts through idb, when idb is installed. Each answer is also a note in the
  summary. `--no-alert-watcher` turns it off.

**`playwright`: Playwright Test against a site.**

- Each spec runs `bunx playwright test <file> --config <wrapper> --output=<spec folder>/artifacts`.
- The wrapper is `playwright.config.mjs` in the run folder. It imports the project's config, keeps its reporters and
  adds the tool's results reporter. It resolves `testDir`, `snapshotDir`, reporter paths, `globalSetup` and
  `globalTeardown` (one or a list) from the project config's folder, for each Playwright project too.
- The site is `--base-url`, else `runner.baseUrl`. The tool only sets `E2E_BASE_URL`: the project's Playwright config
  passes it on, for example `use: { baseURL: process.env.E2E_BASE_URL }`.
- A test's state comes from Playwright's outcome: an unexpected result is `failed`, a skip is `skipped`, and a flaky
  test that passed on a retry is `passed`.

### What a spec process gets and gives back

Every spec process inherits the tool's environment and gets these variables (`E2E_ENV` in
`@genesiscz/utils/e2e/spec-env`). A variable that does not apply to the runner stays unset.

| Variable | Value |
|---|---|
| `E2E_RUN_DIR` | the spec's own folder in the run |
| `E2E_RESULTS_FILE` | the file the spec appends one JSON line per test to |
| `E2E_SPEC` | the spec file, absolute |
| `E2E_PROJECT` | the project id |
| `E2E_DEVICE_UDID`, `E2E_DEVICE_NAME`, `E2E_DEVICE_OS` | wdio: the simulator |
| `E2E_APPIUM_PORT`, `E2E_WDA_PORT`, `E2E_MJPEG_PORT` | wdio: the simulator's ports |
| `E2E_BUNDLE_ID` | wdio: the app under test |
| `E2E_HEADLESS` | wdio: `1` when no simulator window is open |
| `E2E_BASE_URL` | playwright: the site under test |

`--env KEY=VALUE` adds the project's own variables. They come after the runner's variables and `E2E_PROJECT`, so they
can replace those, but never `E2E_RUN_DIR`, `E2E_RESULTS_FILE` or `E2E_SPEC`.

The runner config reads the run with `readE2eSpecContext(process.env)` and writes one line per test with
`recordTestResult`. A line holds `suite`, `title`, `state` (`passed`, `failed` or `skipped`), `durationMs`, and
optionally `error`, `screenshot` and the Playwright `project`. A line that is not JSON, or JSON that is not a test
record, counts as a failed test named "Invalid result line N" in the suite `runner`, so a broken reporter can never
pass a run. Outside `tools e2e` every field of the context is empty and `recordTestResult` writes nothing.

The `spec-env` module runs under Node inside WebdriverIO or Playwright, so it imports only Node built-ins and relative
files: import it by its path. For WebdriverIO:

```ts
import {
    failureScreenshotPath,
    readE2eSpecContext,
    recordTestResult,
    wdioTestResult,
    xcuitestCapabilities,
} from "<GenesisTools>/src/utils/e2e/spec-env";

const run = readE2eSpecContext(process.env);
export const config = {
    port: run.appiumPort ?? 4723,
    capabilities: [xcuitestCapabilities(run, { bundleId: "com.example.shop" })],
    async afterTest(test, _context, result) {
        const screenshot = result.passed ? undefined : failureScreenshotPath(run, test);
        if (screenshot) await browser.saveScreenshot(screenshot);
        recordTestResult(run, wdioTestResult({ test, result, screenshot }));
    },
};
```

- `xcuitestCapabilities` sets the simulator's udid, its own WebDriverAgent and MJPEG ports, and `isHeadless` as the
  tool read it. A wrong `isHeadless` reboots the simulator on Xcode 27. With `app` Appium installs that build; without
  it, Appium attaches to the installed app by bundle id with `noReset`.
- `failureScreenshotPath` names `<spec folder>/shots/FAIL_<suite>_<test>.png`.
- `wdioTestResult` turns `afterTest`'s arguments into a line. A pending test (`this.skip()`) reports `passed: false`
  with `retries.attempts === -1`; it becomes `skipped`, not `failed`.

Playwright needs nothing: the tool adds its reporter (`src/utils/e2e/playwright-reporter.ts`) through the wrapper.

### Where data lives

Runs go under `~/.genesis-tools/e2e/runs/<project>/<time>/`, or `--out`. `<time>` is a file-safe local time stamp
such as `2026-11-04T21-05-33`, to the second. With `GENESIS_TOOLS_HOME` set, runs go to
`$GENESIS_TOOLS_HOME/.genesis-tools/e2e/runs/<project>/`.

| Path in the run folder | What it holds |
|---|---|
| `<spec>-<hash>/runner.log` | the spec process's output |
| `<spec>-<hash>/results.jsonl` | the spec's per-test lines |
| `<spec>-<hash>/shots/`, `wdio-logs/`, `artifacts/` | what the runner writes for the spec |
| `device.log`, `appium.log`, `alerts.jsonl` | wdio: the side files of the run |
| `playwright.config.mjs` | playwright: the wrapper config |
| `summary.json`, `summary.md` | the run's result |

`<hash>` is the first 16 hex digits of the SHA-256 of the spec's path, so each spec has its own folder. `summary.json`
holds the project, the runner, the run folder, the start and end times, the target's facts (the device and ports, or
the site), every spec with its exit code, seconds, log and tests, the counts, the notes and `ok`. `summary.md` is the
same as text, with one line per failed test and its screenshot.

The tool's own log lines go to the day log `~/.genesis-tools/logs/<date>.log` (components `e2e.run`, `e2e.wdio` and
`e2e.project`).

### What it needs on the Mac

- The runner in the project: `@wdio/cli` or `@playwright/test` in the `node_modules` of the project's `cwd`, because
  the tool starts them with `bunx`.
- For `wdio` and `screen`: Xcode with `simctl`, a booted iOS simulator with the app installed (`tools mobile build`),
  and Appium with the XCUITest driver. On Xcode 27 (DeviceHub instead of Simulator.app) the driver must be 12.13.0 or
  newer; 12.22.8 is the newest for Appium 3. The tool refuses to start Appium with an older driver, because that
  driver shuts the simulator down, and with no driver under `APPIUM_HOME` at all. idb is optional (alerts before
  WebDriverAgent is up).
- Nothing costs money. The tool calls the local Appium server and the site under test. `bunx` can download a
  package that the project does not have (Appium too, when `appium` is not on `PATH`).

## Configuration

### The project config

The project config is `e2e.config.ts` (or `e2e/e2e.config.ts`). It default-exports an `E2eProjectConfig` from
`@genesiscz/utils/e2e/project`, and every path in it is relative to the file. The tool checks it when it loads. A
missing required key or a wrong value is an "invalid e2e config" error that names the key. An unknown key (a typo
such as `suite` for `suites`) is ignored without a warning.

A mobile project:

```ts
import type { E2eProjectConfig } from "@genesiscz/utils/e2e/project";

export default {
    id: "shop",
    cwd: "..",                                  // where the runner's node_modules are; default this folder
    runner: { kind: "wdio", config: "wdio.conf.ts", mobile: "mobile.config.ts" },
    specs: { dir: "specs" },                    // pattern default **/*.spec.ts
    pages: "pages",
    suites: { flows: ["pairing.flow", "agents.flow"] },
    hooks: { beforeRun: async ({ environment }) => {}, afterRun: async ({ ok }) => {} },
} satisfies E2eProjectConfig;
```

A web project:

```ts
import type { E2eProjectConfig } from "@genesiscz/utils/e2e/project";

export default {
    id: "shop-web",
    runner: { kind: "playwright", config: "playwright.config.ts", baseUrl: "http://127.0.0.1:5173" },
    specs: { dir: "specs" },
    suites: { smoke: ["home", "checkout"] },
} satisfies E2eProjectConfig;
```

| Key | Meaning |
|---|---|
| `id` | required; letters, digits, `.`, `-`, `_`, starting with a letter or digit; names the run folders |
| `title` | optional; what `config` shows instead of the id |
| `cwd` | where runner processes start; default the config's folder |
| `runner.kind` | `wdio` or `playwright` |
| `runner.config` | required; the `wdio.conf.ts` or `playwright.config.ts` |
| `runner.mobile` | wdio: the app's `mobile.config.ts`; default the nearest upward |
| `runner.baseUrl` | playwright: a URL, used when `--base-url` is not given |
| `specs.dir` | required; the spec folder |
| `specs.pattern` | the glob under `specs.dir`; default `**/*.spec.ts` |
| `pages` | the page object folder that `list` shows |
| `suites` | named lists of spec names, run in that order |
| `hooks.beforeRun` | runs before the first spec |
| `hooks.afterRun` | runs after the last spec, with `ok` |

A hook gets `runDir`, `specs` (the absolute spec files) and `environment` (the variables every spec process gets,
with `--env`); `afterRun` also gets `ok`. Use them to seed a server or reset a fixture.

### Environment variables

- `GENESIS_TOOLS_HOME` names the folder that holds `.genesis-tools`; runs then go to
  `$GENESIS_TOOLS_HOME/.genesis-tools/e2e/runs/<project>/`.
- `APPIUM_HOME` is the Appium home that holds the installed drivers, for an Appium server the tool starts. Default
  `~/.appium`.

## For agents

- `--json` prints one JSON result on every command: `config` (`configPath`, `id`, `runner`, `runnerTitle`, `cwd`,
  `specs`, `pages`, `suites`, `hooks`), `list` (`specs` with `name`, `path` and `file`, `suites`, `pages`), `run`
  and `suite` (the summary, with no progress lines), `screen` (`route`, `ok`, `problems`, `files`, `summary`,
  `logbox`), `report` (`summary.json`) and `compare` (`before`, `after`, `changes`).
- Exit codes: `run` and `suite` exit 1 when the run failed; `report` exits 1 when the run it prints failed; `compare`
  exits 1 when a test newly fails; `screen` exits 1 on any problem. An error (no config, no booted simulator, an
  unknown spec) exits 1 with its message.
- Pass `--udid` whenever more than one simulator may be booted. The tool never picks one of several.
- A failed spec's `runner.log` path is in its result line and in `summary.md`. Read it before you guess.
- The tool has no MCP tools and no plugin skill.

## Troubleshooting

- **"no e2e.config.ts or e2e/e2e.config.ts at or above ..."**. You are outside the project. Run from the project
  folder or pass `--config <file>`.
- **"N simulators are booted (...); pass --udid so another session's is not used"**. Pass `--udid`. With none booted,
  boot one (`xcrun simctl boot <udid>`) or pass `--udid` of a booted one.
- **"<bundle id> is not installed on <udid>; build it first"**. The tool never builds the app. Run
  `tools mobile build` (or `tools mobile up`).
- **"no XCUITest driver under ...: appium driver install xcuitest@12.22.8"**. No Appium answered on the port, so the
  tool must start its own, and it found no driver in `APPIUM_HOME` (default `~/.appium`). This is the first error on
  a fresh Mac. Run `appium driver install xcuitest@12.22.8` with the same `APPIUM_HOME`, or point `APPIUM_HOME` at the
  home that holds the driver.
- **"XCUITest driver ... predates DeviceHub"**. Run
  `appium driver uninstall xcuitest && appium driver install xcuitest@12.22.8`.
- **The simulator reboots during a run.** `isHeadless` did not match the open simulator window. Build the
  capabilities with `xcuitestCapabilities`, and do not open or close the simulator window while a run is on.
- **"Spec basenames must be unique; rename ambiguous nested specs before running."** Two picked specs share a name.
  Rename one, or run them in separate runs.
- **A run fails with EEXIST.** The run folder must be new. With `--out`, pass a folder that does not exist yet. Two
  runs of one project that start in the same second (two agents on two simulators) get the same default folder:
  start the second one a second later, or give each run its own `--out`.
- **A spec fails with `0/0 passed`.** The spec process wrote no result line: the wdio config does not call
  `recordTestResult`, or the runner failed before its first test. Check the spec's `runner.log`.
- **`runner.log` says "bunx did not start", or the runner is not found.** `bunx` is not on `PATH`, or the runner is
  not installed where the specs run. Set `cwd` to the folder whose `node_modules` has it.
- **A test named "Invalid result line N" fails.** A line in `results.jsonl` is not JSON or not a test record. Fix the
  code that writes it.
- **"no run previous for ..."**. The project has only one finished run, or none. A `screen` capture and an unfinished
  run do not count.
- **A playwright run ignores `--base-url`.** The tool only sets `E2E_BASE_URL`. Read it in the project's Playwright
  config (`use.baseURL`).

Run with `-v` for debug lines, and read `~/.genesis-tools/logs/<date>.log` for the `e2e.*` components.

## Related

- [tools mobile](../mobile/README.md) owns `mobile.config.ts`, builds and installs the app, lists the routes that
  `screen` opens, and starts and stops the Appium server this tool uses.
