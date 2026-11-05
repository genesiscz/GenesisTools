import type { Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { type E2eTestResult, type E2eTestState, readE2eSpecContext, recordTestResult } from "./spec-env";

/** Playwright's outcome as a result state: a timeout or an interruption is a failure, a skip stays a skip. */
export function playwrightState(status: TestResult["status"]): E2eTestState {
    if (status === "passed") {
        return "passed";
    }

    return status === "skipped" ? "skipped" : "failed";
}

export function playwrightTestResult(test: Pick<TestCase, "title" | "titlePath">, result: TestResult): E2eTestResult {
    const state = playwrightState(result.status);
    // titlePath is ["", project, file, ...describe blocks, test]; the suite is the describe blocks.
    const suite = test.titlePath().slice(3, -1).join(" > ") || test.titlePath()[2] || "";
    const screenshot = result.attachments.find((attachment) => attachment.contentType === "image/png")?.path;

    return {
        suite,
        title: test.title,
        state,
        durationMs: result.duration,
        ...(state === "failed" ? { error: result.error?.message ?? "", screenshot } : {}),
    };
}

/**
 * The reporter `tools e2e` adds to a Playwright run (`--reporter`): one JSON line per test into the run's results
 * file, beside the project's own reporters. It runs inside Playwright's loader under Node.
 */
export default class E2eResultsReporter implements Reporter {
    // Playwright loads this under Node with the project's tsconfig, where the @genesiscz/utils/env alias does not resolve.
    private readonly context = readE2eSpecContext(process.env);

    private suite?: Suite;

    onBegin(_config: unknown, suite: Suite): void {
        this.suite = suite;
    }

    onEnd(): void {
        for (const test of this.suite?.allTests() ?? []) {
            const result = test.results.at(-1);

            if (!result) {
                continue;
            }

            const mapped = playwrightTestResult(test, result);
            const outcome = test.outcome();
            mapped.state = outcome === "unexpected" ? "failed" : outcome === "skipped" ? "skipped" : "passed";
            recordTestResult(this.context, mapped);
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
