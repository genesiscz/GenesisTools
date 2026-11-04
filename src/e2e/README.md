# tools e2e

Runs a project's e2e specs one runner process per spec file and collects the results, screenshots and logs into one
run folder. The tool owns the run; the project owns its specs, page objects, runner config and hooks.

```bash
tools e2e config                          # the e2e project this folder resolves to
tools e2e list                            # spec files and named suites
tools e2e run agents.flow --udid <udid>   # a spec name, a path, or a word in the name
tools e2e suite flows --udid <udid> --env TEST_SERVER=http://127.0.0.1:3143
tools e2e screen agents --udid <udid> --expect screen-agents
tools e2e report [latest|previous|<stamp>|<run folder>]
tools e2e compare [before] [after]        # tests whose state changed; default previous → latest
```

## The project config

Every command reads `--config <file>`, or else the nearest `e2e.config.ts` or `e2e/e2e.config.ts` at or above the
working folder. It default-exports an `E2eProjectConfig` (`@genesiscz/utils/e2e/project`); paths are relative to it.

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

`runner.kind` picks one runner from the `RUNNERS` table (`src/e2e/lib/runners/`):

- `wdio`: WebdriverIO with Appium on an iOS simulator. The app comes from the project's `mobile.config.ts`
  (`runner.mobile`, or the nearest one upward; see `tools mobile`). The tool picks the simulator (`--udid`, or the only
  booted one), starts its own Appium on the simulator's port when none answers (`--appium-port` names another), and
  runs `bunx wdio run <config> --spec <file>` per spec. Beside the specs it keeps `device.log` (the app's process
  log), `appium.log` (the server's lines during the run) and `alerts.jsonl` (the system alerts the watcher answered
  or left; `--no-alert-watcher` turns it off).
- `playwright`: Playwright Test against a site: `bunx playwright test <file> --config <config>` per spec, with the
  run's results reporter added and the artifacts in the spec's folder. The site is `--base-url`, else
  `runner.baseUrl`.

## What a spec process gets and gives back

The tool sets `E2E_*` variables for every spec process (`E2E_ENV` in `@genesiscz/utils/e2e/spec-env`): its run folder
and results file, the spec, the project, and per runner the simulator, its Appium, WebDriverAgent and MJPEG ports,
the bundle id and whether a simulator UI is open, or the site. `--env KEY=VALUE` adds the project's own.

The runner config reads them with `readE2eSpecContext(process.env)` and writes one line per test with
`recordTestResult`. That module runs under Node inside WebdriverIO or Playwright, so it imports only Node built-ins
and relative files: import it by its path. For WebdriverIO:

```ts
import { failureScreenshotPath, readE2eSpecContext, recordTestResult, wdioTestResult, xcuitestCapabilities } from "<GenesisTools>/src/utils/e2e/spec-env";

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

Playwright needs nothing: the tool adds its reporter (`@genesiscz/utils/e2e/playwright-reporter`).

## The run folder

`~/.genesis-tools/e2e/runs/<id>/<time>/` (or `--out`): per spec `<spec>/runner.log`, `<spec>/results.jsonl` and
whatever the runner writes there (`shots/`, `wdio-logs/`, `artifacts/`); for the run the runner's side files,
`summary.json` and `summary.md`. A spec fails when its runner exits non-zero, a test fails, or it reported no test.

`screen <route>` opens one screen of a mobile project (the `mobile.config.ts` beside the e2e config, or `--mobile`),
captures it, and fails when its root never shows, an `--expect` testID is missing, a LogBox covers it or an alert is
open.
