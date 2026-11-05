import { join, resolve } from "node:path";
import { E2E_ENV } from "@genesiscz/utils/e2e/spec-env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
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
    async prepare({ project, runner, flags }): Promise<RunTarget> {
        const baseUrl = stringFlag(flags.baseUrl) ?? runner.baseUrl;
        const config = resolve(project.dir, runner.config);

        return {
            facts: baseUrl ? { site: baseUrl } : {},
            environment: baseUrl ? { [E2E_ENV.baseUrl]: baseUrl } : {},
            command: (spec, specDir) => [
                "bunx",
                "playwright",
                "test",
                spec.file,
                "--config",
                config,
                `--reporter=list,${RESULTS_REPORTER}`,
                `--output=${join(specDir, "artifacts")}`,
            ],
            finish: async () => [],
        };
    },
};
