import { spawn } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type AlertAnswer, type AlertBackend, AlertWatcher, alertBackendFor } from "@genesiscz/utils/mobile/alerts";
import { appiumStatus } from "@genesiscz/utils/mobile/appium";
import { installedAppInfo, type SimDevice, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import type { E2eSetup, MobileApp } from "./types";

const log = logger.child({ component: "mobile.e2e" });

export interface SpecFile {
    /** The file name without `.spec.ts`: `agents.flow`. */
    name: string;
    /** The path relative to the app folder. */
    path: string;
}

export function e2eSetup(app: MobileApp): E2eSetup {
    if (!app.e2e) {
        throw new Error(`${app.id} has no e2e suite`);
    }

    return app.e2e;
}

export function listSpecs(app: MobileApp, appDir: string): SpecFile[] {
    const setup = e2eSetup(app);
    return [...new Bun.Glob("**/*.spec.ts").scanSync({ cwd: join(appDir, setup.specsDir), onlyFiles: true })]
        .sort()
        .map((file) => ({ name: basename(file).replace(/\.spec\.ts$/, ""), path: join(setup.specsDir, file) }));
}

/** The specs named: an exact name first, else every spec whose name contains the word. */
export function resolveSpecs(all: SpecFile[], names: string[]): SpecFile[] {
    const picked = names.flatMap((name) => {
        const exact = all.filter((spec) => spec.name === name || spec.path === name);
        const matches = exact.length > 0 ? exact : all.filter((spec) => spec.name.includes(name));

        if (matches.length === 0) {
            throw new Error(`no spec matches "${name}"; specs: ${all.map((spec) => spec.name).join(", ")}`);
        }

        return matches;
    });
    return [...new Map(picked.map((spec) => [spec.path, spec])).values()];
}

/** A named suite's specs; `all` is every spec. */
export function suiteSpecs(app: MobileApp, appDir: string, suite: string): SpecFile[] {
    const all = listSpecs(app, appDir);

    if (suite === "all") {
        return all;
    }

    const names = e2eSetup(app).suites[suite];

    if (!names) {
        throw new Error(`no suite "${suite}"; suites: all, ${Object.keys(e2eSetup(app).suites).join(", ")}`);
    }

    return resolveSpecs(all, names);
}

export interface TestResult {
    suite: string;
    title: string;
    state: "passed" | "failed" | "skipped";
    durationMs: number;
    error?: string;
    screenshot?: string;
}

export interface SpecRun {
    spec: SpecFile;
    dir: string;
    exitCode: number | null;
    seconds: number;
    log: string;
    tests: TestResult[];
}

export interface RunSummary {
    app: string;
    runDir: string;
    startedAt: string;
    finishedAt: string;
    device: { udid: string; name: string; osVersion: string };
    appiumPort: number;
    wdaPort: number;
    agentUrl?: string;
    specs: SpecRun[];
    counts: { passed: number; failed: number; skipped: number; specsFailed: number };
    alerts: AlertAnswer[];
    ok: boolean;
}

export function readResults(path: string): TestResult[] {
    if (!existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => SafeJSON.parse(line, { strict: true }) as TestResult);
}

/** A spec failed when its runner exited non-zero, or any test failed, or it reported no test at all. */
export function specFailed(run: Pick<SpecRun, "exitCode" | "tests">): boolean {
    return run.exitCode !== 0 || run.tests.length === 0 || run.tests.some((test) => test.state === "failed");
}

export function countResults(specs: SpecRun[]): RunSummary["counts"] {
    const tests = specs.flatMap((spec) => spec.tests);
    return {
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
        skipped: tests.filter((test) => test.state === "skipped").length,
        specsFailed: specs.filter(specFailed).length,
    };
}

/** The summary as markdown: one line per spec and per failed test, the counts, and every alert the watcher saw. */
export function formatSummary(summary: RunSummary): string {
    const { counts } = summary;
    const lines = [
        `# Mobile e2e run ${summary.startedAt}`,
        "",
        `- App: ${summary.app}`,
        `- Device: ${summary.device.name} (${summary.device.udid}, iOS ${summary.device.osVersion})`,
        `- Appium :${summary.appiumPort}, WDA :${summary.wdaPort}${summary.agentUrl ? `, agent ${summary.agentUrl}` : ""}`,
        `- Result: ${summary.ok ? "passed" : "FAILED"}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped in ${summary.specs.length} spec(s)`,
        "",
        "## Specs",
        "",
    ];

    for (const spec of summary.specs) {
        const passed = spec.tests.filter((test) => test.state === "passed").length;
        lines.push(
            `- ${specFailed(spec) ? "FAIL" : "ok"} ${spec.spec.name}: ${passed}/${spec.tests.length} passed, exit ${spec.exitCode}, ${spec.seconds} s (log ${spec.log})`
        );

        for (const test of spec.tests.filter((candidate) => candidate.state === "failed")) {
            lines.push(`    - ${test.suite} > ${test.title}: ${(test.error ?? "").split("\n")[0]}`);

            if (test.screenshot) {
                lines.push(`      screenshot ${test.screenshot}`);
            }
        }
    }

    lines.push("", "## System alerts", "");

    if (summary.alerts.length === 0) {
        lines.push("- none");
    }

    for (const alert of summary.alerts) {
        lines.push(
            `- ${alert.at} ${alert.rule ?? "unknown"}: ${alert.tapped ? `tapped ${alert.tapped}` : "left alone"} (${alert.text.replace(/\n/g, " / ")})`
        );
    }

    return `${lines.join("\n")}\n`;
}

function runSpec(options: {
    appDir: string;
    config: string;
    spec: SpecFile;
    environment: Record<string, string | undefined>;
    logPath: string;
    onLine?: (line: string) => void;
}): Promise<number | null> {
    return new Promise((resolve) => {
        const fd = openSync(options.logPath, "a");
        const child = spawn("bunx", ["wdio", "run", options.config, "--spec", options.spec.path], {
            cwd: options.appDir,
            env: options.environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const pump = (chunk: Buffer) => {
            appendFileSync(fd, chunk);

            for (const line of chunk.toString("utf8").split("\n")) {
                if (line.trim()) {
                    options.onLine?.(line);
                }
            }
        };
        child.stdout.on("data", pump);
        child.stderr.on("data", pump);
        child.once("close", (code) => {
            closeSync(fd);
            resolve(code);
        });
        child.once("error", (error) => {
            appendFileSync(fd, `\n[tools mobile] spawn failed: ${error.message}\n`);
            log.error({ error, spec: options.spec.path }, "wdio spawn failed");
        });
    });
}

/**
 * The app's console while the run lasts: `log stream` on the simulator for the app's process, so a failed assertion
 * has the app's own lines next to it.
 */
function streamDeviceLog(udid: string, processName: string, path: string): () => void {
    const fd = openSync(path, "a");
    const child = spawn(
        "xcrun",
        ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--predicate", `process == "${processName}"`],
        { stdio: ["ignore", fd, fd] }
    );
    closeSync(fd);
    return () => child.kill("SIGTERM");
}

/**
 * Runs spec files one runner process each against one simulator, with the simulator's own Appium and WDA ports, and
 * collects everything into `runDir`: per spec `<spec>/wdio.log`, `<spec>/results.jsonl` (the runner's per-test
 * lines), `<spec>/shots/`; for the run `alerts.jsonl`, `device.log`, `appium.log` (the server's lines during the run),
 * `summary.json` and `summary.md`. An alert watcher answers known system alerts the whole time.
 */
export async function runE2e(options: {
    app: MobileApp;
    appDir: string;
    device: SimDevice;
    specs: SpecFile[];
    appiumPort: number;
    runDir: string;
    agentUrl?: string;
    watchAlerts: boolean;
    onSpecStart?: (spec: SpecFile, index: number, total: number) => void;
    onSpecDone?: (run: SpecRun) => void;
    onLine?: (line: string) => void;
}): Promise<RunSummary> {
    const { app, appDir, device, runDir } = options;
    const setup = e2eSetup(app);
    const bundleId = app.bundleId(appDir);
    const wdaPort = wdaPortsFor(device.udid).wda;
    const startedAt = new Date().toISOString();
    mkdirSync(runDir, { recursive: true });

    const info = await installedAppInfo(device.udid, bundleId);
    const stopDeviceLog = streamDeviceLog(
        device.udid,
        info?.bundleName || app.ios.productName,
        join(runDir, "device.log")
    );
    const appium = await appiumStatus(options.appiumPort);
    const appiumOffset = existsSync(appium.log) ? statSync(appium.log).size : 0;

    const alerts: AlertAnswer[] = [];
    const alertsPath = join(runDir, "alerts.jsonl");
    let backend: AlertBackend | null = null;
    let watcher: AlertWatcher | null = null;
    let watching = options.watchAlerts;
    const watch = async () => {
        while (watching) {
            try {
                if (!watcher) {
                    // WDA comes up with the runner's first session; until then only idb can see an alert.
                    backend = await alertBackendFor({ udid: device.udid, wdaPort });
                    watcher = backend
                        ? new AlertWatcher({
                              backend,
                              appName: info?.displayName ?? "",
                              onAnswer: (answer) => {
                                  alerts.push(answer);
                                  appendFileSync(alertsPath, `${SafeJSON.stringify(answer)}\n`);
                              },
                          })
                        : null;
                }

                await watcher?.check();

                if (
                    backend?.kind === "idb" &&
                    (await alertBackendFor({ udid: device.udid, wdaPort, order: ["wda"] }))
                ) {
                    watcher = null;
                }
            } catch (error) {
                log.debug({ error }, "alert watch tick failed");
                watcher = null;
            }

            await Bun.sleep(1_500);
        }
    };
    const watchDone = watch();

    const specs: SpecRun[] = [];
    try {
        for (const [index, spec] of options.specs.entries()) {
            options.onSpecStart?.(spec, index, options.specs.length);
            const dir = join(runDir, spec.name);
            mkdirSync(dir, { recursive: true });
            const logPath = join(dir, "wdio.log");
            const started = performance.now();
            const environment = {
                ...env.getProcessEnv(),
                ...setup.env({
                    udid: device.udid,
                    deviceName: device.name,
                    osVersion: device.osVersion,
                    appiumPort: options.appiumPort,
                    wdaPort,
                    bundleId,
                    runDir: dir,
                    agentUrl: options.agentUrl,
                }),
            };
            log.info({ spec: spec.path, dir }, "spec start");
            const exitCode = await runSpec({
                appDir,
                config: setup.config,
                spec,
                environment,
                logPath,
                onLine: options.onLine,
            });
            const run: SpecRun = {
                spec,
                dir,
                exitCode,
                seconds: Math.round((performance.now() - started) / 1000),
                log: logPath,
                tests: readResults(join(dir, setup.resultsFile)),
            };
            specs.push(run);
            log.info({ spec: spec.path, exitCode, tests: run.tests.length }, "spec done");
            options.onSpecDone?.(run);
        }
    } finally {
        watching = false;
        await watchDone;
        stopDeviceLog();

        if (existsSync(appium.log)) {
            const text = readFileSync(appium.log);
            writeFileSync(join(runDir, "appium.log"), text.subarray(Math.min(appiumOffset, text.length)));
        }
    }

    const counts = countResults(specs);
    const summary: RunSummary = {
        app: app.id,
        runDir,
        startedAt,
        finishedAt: new Date().toISOString(),
        device: { udid: device.udid, name: device.name, osVersion: device.osVersion },
        appiumPort: options.appiumPort,
        wdaPort,
        agentUrl: options.agentUrl,
        specs,
        counts,
        alerts,
        ok: counts.specsFailed === 0,
    };
    writeFileSync(join(runDir, "summary.json"), SafeJSON.stringify(summary, null, 2));
    writeFileSync(join(runDir, "summary.md"), formatSummary(summary));
    return summary;
}
