import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "../json";

/**
 * What `tools e2e` hands every spec process, and the one line per test a spec process hands back. A project's runner
 * config (`wdio.conf.ts`, `playwright.config.ts`) imports this file: it runs under Node inside WebdriverIO or
 * Playwright, so it imports nothing but Node built-ins and relative files, and it reads the environment it is given
 * instead of `process.env`.
 */

/** The variables `tools e2e` sets for a spec process. A runner that does not apply leaves its variables unset. */
export const E2E_ENV = {
    /** The spec's own run folder: its screenshots, logs and results go here. */
    runDir: "E2E_RUN_DIR",
    /** The file the spec process appends one JSON line per test to (`recordTestResult`). */
    resultsFile: "E2E_RESULTS_FILE",
    /** The spec file, absolute. */
    spec: "E2E_SPEC",
    /** The project id from `e2e.config.ts`. */
    project: "E2E_PROJECT",
    /** WebdriverIO with Appium: the simulator, its Appium and WebDriverAgent ports, and the app under test. */
    udid: "E2E_DEVICE_UDID",
    deviceName: "E2E_DEVICE_NAME",
    deviceOs: "E2E_DEVICE_OS",
    appiumPort: "E2E_APPIUM_PORT",
    wdaPort: "E2E_WDA_PORT",
    mjpegPort: "E2E_MJPEG_PORT",
    bundleId: "E2E_BUNDLE_ID",
    /** `1` when no simulator UI is open, so Appium's `isHeadless` must be true. */
    headless: "E2E_HEADLESS",
    /** Playwright: the site under test. */
    baseUrl: "E2E_BASE_URL",
} as const;

export type E2eTestState = "passed" | "failed" | "skipped";

/** One test's outcome, one JSON line in the results file. */
export interface E2eTestResult {
    suite: string;
    title: string;
    state: E2eTestState;
    durationMs: number;
    error?: string;
    screenshot?: string;
}

export interface E2eSpecDevice {
    udid: string;
    name: string;
    os: string;
}

/** The run as a spec process sees it; every field is absent when the spec runs outside `tools e2e`. */
export interface E2eSpecContext {
    runDir?: string;
    resultsFile?: string;
    /** `<runDir>/shots`, where failure screenshots go. */
    shotsDir?: string;
    spec?: string;
    project?: string;
    device?: E2eSpecDevice;
    appiumPort?: number;
    wdaPort?: number;
    mjpegPort?: number;
    bundleId?: string;
    headless?: boolean;
    baseUrl?: string;
}

function text(environment: Record<string, string | undefined>, key: string): string | undefined {
    return environment[key]?.trim() || undefined;
}

function port(environment: Record<string, string | undefined>, key: string): number | undefined {
    const value = Number(text(environment, key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Reads the run from a spec process's environment (pass `process.env`). */
export function readE2eSpecContext(environment: Record<string, string | undefined>): E2eSpecContext {
    const runDir = text(environment, E2E_ENV.runDir);
    const udid = text(environment, E2E_ENV.udid);
    const headless = text(environment, E2E_ENV.headless);

    return {
        runDir,
        resultsFile: text(environment, E2E_ENV.resultsFile) ?? (runDir ? join(runDir, "results.jsonl") : undefined),
        shotsDir: runDir ? join(runDir, "shots") : undefined,
        spec: text(environment, E2E_ENV.spec),
        project: text(environment, E2E_ENV.project),
        device: udid
            ? {
                  udid,
                  name: text(environment, E2E_ENV.deviceName) ?? udid,
                  os: text(environment, E2E_ENV.deviceOs) ?? "",
              }
            : undefined,
        appiumPort: port(environment, E2E_ENV.appiumPort),
        wdaPort: port(environment, E2E_ENV.wdaPort),
        mjpegPort: port(environment, E2E_ENV.mjpegPort),
        bundleId: text(environment, E2E_ENV.bundleId),
        headless: headless === undefined ? undefined : headless === "1",
        baseUrl: text(environment, E2E_ENV.baseUrl),
    };
}

/** Appends one test's line to the results file; a spec run outside `tools e2e` has none and records nothing. */
export function recordTestResult(context: Pick<E2eSpecContext, "resultsFile">, result: E2eTestResult): void {
    if (!context.resultsFile) {
        return;
    }

    mkdirSync(dirname(context.resultsFile), { recursive: true });
    appendFileSync(context.resultsFile, `${SafeJSON.stringify(result)}\n`);
}

/** The parts of WebdriverIO's `afterTest(test, context, result)` arguments the result line needs. */
export interface WdioTestArgs {
    test: { parent: string; title: string };
    result: { passed: boolean; duration: number; error?: unknown; retries?: { attempts: number } | null };
    screenshot?: string;
}

/**
 * WebdriverIO's `afterTest` arguments as a result line. A pending test (`this.skip()`) reports `passed: false` with
 * `retries.attempts === -1`; it is a skip, not a failure.
 */
export function wdioTestResult({ test, result, screenshot }: WdioTestArgs): E2eTestResult {
    const base = { suite: test.parent, title: test.title, durationMs: result.duration };

    if (result.passed) {
        return { ...base, state: "passed" };
    }

    if (result.retries?.attempts === -1) {
        return { ...base, state: "skipped" };
    }

    const error = result.error instanceof Error ? result.error.message : String(result.error ?? "");
    return { ...base, state: "failed", error, screenshot };
}

/** A file-safe screenshot name for a failed test: `FAIL_<suite>_<test>.png` in the shots folder. */
export function failureScreenshotPath(context: Pick<E2eSpecContext, "shotsDir">, test: WdioTestArgs["test"]) {
    if (!context.shotsDir) {
        return undefined;
    }

    const safe = `${test.parent} ${test.title}`.replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
    return join(context.shotsDir, `FAIL_${safe}.png`);
}

/**
 * The XCUITest capabilities for a WebdriverIO run on the simulator `tools e2e` picked: its udid, its own WDA and MJPEG
 * ports (so two runs on two simulators never kill each other's WebDriverAgent), and `isHeadless` as the tool read it
 * (a wrong value reboots the simulator on Xcode 27). With `app` Appium installs that build; without it, it attaches to
 * the installed app by bundle id with `noReset`.
 */
export function xcuitestCapabilities(
    context: E2eSpecContext,
    options: { bundleId: string; app?: string; deviceName?: string; platformVersion?: string }
): Record<string, unknown> {
    return {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": context.device?.name ?? options.deviceName,
        "appium:platformVersion": context.device?.os || options.platformVersion,
        ...(context.device ? { "appium:udid": context.device.udid } : {}),
        ...(options.app
            ? { "appium:app": options.app }
            : { "appium:bundleId": options.bundleId, "appium:noReset": true }),
        ...(context.wdaPort ? { "appium:wdaLocalPort": context.wdaPort } : {}),
        ...(context.mjpegPort ? { "appium:mjpegServerPort": context.mjpegPort } : {}),
        ...(context.headless === undefined ? {} : { "appium:isHeadless": context.headless }),
        "appium:newCommandTimeout": 240,
        "appium:wdaLaunchTimeout": 120_000,
        "appium:wdaConnectionTimeout": 120_000,
    };
}
