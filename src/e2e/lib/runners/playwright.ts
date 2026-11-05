import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_ENV } from "@genesiscz/utils/e2e/spec-env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { type E2eRunner, type RunTarget, stringFlag } from "./types";

/** The reporter that writes one result line per test; Playwright loads it by path beside the project's reporters. */
export const RESULTS_REPORTER = resolve(moduleDir(import.meta), "../../../utils/e2e/playwright-reporter.ts");

/**
 * Playwright Test against a site: `playwright test <spec>` with the project's config, the run's reporter added and the
 * artifacts (traces, failure screenshots) in the spec's run folder. The site is `--base-url`, else the runner's
 * `baseUrl`; a spec reads it as `E2E_BASE_URL`.
 */
export const playwrightRunner: E2eRunner<"playwright"> = {
    kind: "playwright",
    title: "Playwright Test against a site",
    flags: [{ flags: "--base-url <url>", description: "playwright: the site under test (default: runner.baseUrl)" }],
    async prepare({ project, runner, flags, runDir }): Promise<RunTarget> {
        const baseUrl = stringFlag(flags.baseUrl) ?? runner.baseUrl;
        const config = resolve(project.dir, runner.config);
        const wrapper = join(runDir, "playwright.config.mjs");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
            wrapper,
            `import original from ${SafeJSON.stringify(pathToFileURL(config).href)};
import { resolve } from "node:path";
const base = ${SafeJSON.stringify(dirname(config))};
const reporters = original.reporter ?? [["list"]];
const list = typeof reporters === "string" ? [[reporters]] : reporters;
const builtins = new Set(["list", "line", "dot", "html", "json", "junit", "null", "github", "blob"]);
const reporter = list.map(([name, ...options]) => [builtins.has(name) ? name : resolve(base, name), ...options]);
const hook = (value) => Array.isArray(value) ? value.map((entry) => resolve(base, entry)) : resolve(base, value);
const directories = (value) => ({ ...value, testDir: resolve(base, value.testDir ?? original.testDir ?? "."), ...(value.snapshotDir ? { snapshotDir: resolve(base, value.snapshotDir) } : {}) });
export default { ...directories(original), ...(original.projects ? { projects: original.projects.map(directories) } : {}),
 reporter: [...reporter, [${SafeJSON.stringify(RESULTS_REPORTER)}]],
 ...(original.globalSetup ? { globalSetup: hook(original.globalSetup) } : {}),
 ...(original.globalTeardown ? { globalTeardown: hook(original.globalTeardown) } : {}) };
`
        );

        return {
            facts: baseUrl ? { site: baseUrl } : {},
            environment: baseUrl ? { [E2E_ENV.baseUrl]: baseUrl } : {},
            command: (spec, specDir) => [
                "bunx",
                "playwright",
                "test",
                spec.file,
                "--config",
                wrapper,
                `--output=${join(specDir, "artifacts")}`,
            ],
            finish: async () => [],
        };
    },
};
