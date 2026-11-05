import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2eProject } from "@genesiscz/utils/e2e/project";
import { E2E_ENV, type E2eTestResult } from "@genesiscz/utils/e2e/spec-env";
import * as mobileAppium from "@genesiscz/utils/mobile/appium";
import * as mobileProject from "@genesiscz/utils/mobile/project";
import * as mobileSession from "@genesiscz/utils/mobile/session";
import * as mobileSimulator from "@genesiscz/utils/mobile/simulator";
import { runDirOf } from "../commands/report";
import { listRunDirs, runsRoot, stamp } from "./paths";
import { runE2e, runSpec } from "./run";
import { RUNNERS, runnerFlags } from "./runners";
import { listSpecs, resolveSpecs, specName, suiteSpecs } from "./specs";
import { compareRuns, countResults, formatSummary, type RunSummary, readResults, specFailed } from "./summary";

const root = mkdtempSync(join(tmpdir(), "gt-e2e-run-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

function fixtureProject(name: string): E2eProject {
    const dir = join(root, name);
    mkdirSync(join(dir, "specs", "flows"), { recursive: true });

    for (const file of [
        "flows/agents.flow.spec.ts",
        "flows/pairing.flow.spec.ts",
        "screens.tour.spec.ts",
        "notes.md",
    ]) {
        writeFileSync(join(dir, "specs", file), "");
    }

    return {
        configPath: join(dir, "e2e.config.ts"),
        dir,
        cwd: dir,
        config: {
            id: "shop",
            runner: { kind: "wdio", config: "wdio.conf.ts" },
            specs: { dir: "specs" },
            suites: { flows: ["pairing.flow", "agents.flow"] },
        },
    };
}

describe("specs", () => {
    it("lists spec files under the spec folder, named without their suffix", () => {
        const project = fixtureProject("list");
        expect(listSpecs(project).map((spec) => [spec.name, spec.path])).toEqual([
            ["agents.flow", "specs/flows/agents.flow.spec.ts"],
            ["pairing.flow", "specs/flows/pairing.flow.spec.ts"],
            ["screens.tour", "specs/screens.tour.spec.ts"],
        ]);
        expect(specName("checkout.e2e.ts")).toBe("checkout");
    });

    it("resolves names and words, keeps a suite's order, and refuses an unknown name", () => {
        const project = fixtureProject("resolve");
        const all = listSpecs(project);
        expect(resolveSpecs(all, ["agents", "agents.flow"]).map((spec) => spec.name)).toEqual(["agents.flow"]);
        expect(resolveSpecs(all, ["flow"]).map((spec) => spec.name)).toEqual(["agents.flow", "pairing.flow"]);
        expect(suiteSpecs(project, all, "flows").map((spec) => spec.name)).toEqual(["pairing.flow", "agents.flow"]);
        expect(suiteSpecs(project, all, "all")).toHaveLength(3);
        expect(() => suiteSpecs(project, all, "nope")).toThrow('no suite "nope"; suites: all, flows');
        expect(() => resolveSpecs(all, ["nope"])).toThrow('no spec matches "nope"');
    });
});

describe("runners", () => {
    it("has one runner per kind, and every runner flag once", () => {
        expect(Object.keys(RUNNERS).sort()).toEqual(["playwright", "wdio"]);
        const flags = runnerFlags().map((flag) => flag.flags);
        expect(flags).toContain("--udid <udid>");
        expect(flags).toContain("--base-url <url>");
        expect(new Set(flags).size).toBe(flags.length);
    });

    it("runs Playwright with the results reporter and the artifacts in the spec's folder", async () => {
        const project = fixtureProject("playwright");
        writeFileSync(
            join(project.dir, "playwright.config.ts"),
            `export default { globalSetup: ["./seed.ts", "./auth.ts"], globalTeardown: ["./clean.ts"], reporter: [["junit"]] };`
        );
        const target = await RUNNERS.playwright.prepare({
            project,
            runner: { kind: "playwright", config: "playwright.config.ts", baseUrl: "http://127.0.0.1:5173" },
            flags: { baseUrl: "http://127.0.0.1:4000" },
            runDir: join(root, "playwright-run"),
        });
        const [spec] = listSpecs(project);

        expect(target.environment).toEqual({ [E2E_ENV.baseUrl]: "http://127.0.0.1:4000" });
        const command = target.command(spec, "/runs/x/agents.flow");
        expect(command.slice(0, 4)).toEqual(["bunx", "playwright", "test", spec.file]);
        expect(command.some((part) => part.startsWith("--reporter="))).toBe(false);
        const wrapper = command[command.indexOf("--config") + 1];
        expect(readFileSync(wrapper, "utf8")).toContain("playwright-reporter.ts");
        expect(readFileSync(wrapper, "utf8")).toContain("original.reporter");
        const composed = (await import(wrapper)).default;
        expect(composed.globalSetup).toEqual([join(project.dir, "seed.ts"), join(project.dir, "auth.ts")]);
        expect(composed.globalTeardown).toEqual([join(project.dir, "clean.ts")]);
        expect(composed.reporter[0]).toEqual(["junit"]);
        expect(command).toContain("--output=/runs/x/agents.flow/artifacts");
    });
});

describe("run loop", () => {
    it("runs both cleanup paths after setup fails and preserves the setup error", async () => {
        const project = fixtureProject("setup-failure");
        const calls: string[] = [];
        project.config.hooks = {
            beforeRun: async () => {
                throw new Error("setup failed");
            },
            afterRun: async ({ ok }) => {
                calls.push(`after:${ok}`);
                throw new Error("teardown failed");
            },
        };
        await expect(
            runE2e({
                project,
                specs: listSpecs(project).slice(0, 1),
                runDir: join(root, "setup-failure-run"),
                flags: {},
                extraEnv: {},
                prepare: async () => ({
                    facts: {},
                    environment: {},
                    command: () => [],
                    finish: async () => {
                        calls.push("finish");
                        throw new Error("target cleanup failed");
                    },
                }),
            })
        ).rejects.toThrow("setup failed");
        expect(calls).toEqual(["finish", "after:false"]);
    });

    it("refuses an existing run directory before preparing a target", async () => {
        const project = fixtureProject("reuse");
        const runDir = join(root, "reused-run");
        mkdirSync(runDir);
        writeFileSync(join(runDir, "results.jsonl"), "old results");
        let prepared = false;
        await expect(
            runE2e({
                project,
                specs: listSpecs(project).slice(0, 1),
                runDir,
                flags: {},
                extraEnv: {},
                prepare: async () => {
                    prepared = true;
                    throw new Error("must not prepare");
                },
            })
        ).rejects.toThrow();
        expect(prepared).toBe(false);
        expect(readFileSync(join(runDir, "results.jsonl"), "utf8")).toBe("old results");
    });

    it("refuses duplicate artifact names before preparing a target", async () => {
        const project = fixtureProject("duplicate");
        const spec = listSpecs(project)[0];
        let prepared = false;
        await expect(
            runE2e({
                project,
                specs: [spec, { ...spec, path: "another/agents.flow.spec.ts" }],
                runDir: join(root, "duplicate-run"),
                flags: {},
                extraEnv: {},
                prepare: async () => {
                    prepared = true;
                    throw new Error("must not run");
                },
            })
        ).rejects.toThrow("basenames must be unique");
        expect(prepared).toBe(false);
    });

    it("gives each spec process its folder, results file and the target's variables, and writes the summary", async () => {
        const project = fixtureProject("loop");
        const runDir = join(root, "loop-run");
        const writer = join(root, "write-result.ts");
        // A stand-in runner: it records what it got as one result line, and fails the pairing spec.
        writeFileSync(
            writer,
            `const name = process.env.E2E_SPEC.split("/").pop();
             const line = { suite: process.env.E2E_PROJECT + " " + process.env.GT_EXTRA, title: name, state: name.startsWith("pairing") ? "failed" : "passed", durationMs: 1, error: process.env.E2E_DEVICE_UDID };
             require("node:fs").appendFileSync(process.env.E2E_RESULTS_FILE, JSON.stringify(line) + "\\n");
             process.exit(name.startsWith("pairing") ? 1 : 0);`
        );
        const summary = await runE2e({
            project,
            specs: listSpecs(project).slice(0, 2),
            runDir,
            flags: {},
            extraEnv: { GT_EXTRA: "extra" },
            prepare: async () => ({
                facts: { device: "gt-w402" },
                environment: { [E2E_ENV.udid]: "SIM-1" },
                command: (spec) => [process.execPath, writer, spec.file],
                finish: async () => [{ at: "t", source: "alert open-in (wda)", text: "tapped Open" }],
            }),
        });

        expect(summary.counts).toEqual({ passed: 1, failed: 1, skipped: 0, specsFailed: 1 });
        expect(summary.ok).toBe(false);
        expect(summary.specs[0].tests[0]).toMatchObject({
            suite: "shop extra",
            title: "agents.flow.spec.ts",
            error: "SIM-1",
        });
        expect(summary.specs[1].exitCode).toBe(1);
        expect(summary.notes).toHaveLength(1);
        expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("- FAIL pairing.flow: 0/1 passed, exit 1");
        expect(existsSync(summary.specs[0].log)).toBe(true);
        expect(summary.specs[0].dir).not.toBe(summary.specs[1].dir);
        let prepared = false;
        await expect(
            runE2e({
                project,
                specs: listSpecs(project),
                runDir,
                flags: {},
                extraEnv: {},
                prepare: async () => {
                    prepared = true;
                    throw new Error("must not prepare a reused folder");
                },
            })
        ).rejects.toThrow();
        expect(prepared).toBe(false);
    });
});

describe("a runner that does not start", () => {
    it("fails its spec and writes why into the spec log (a missing program is the shell's 127 and its own stderr line)", async () => {
        const logPath = join(root, "no-runner.log");
        const lines: string[] = [];
        const status = await runSpec({
            command: ["true"],
            cwd: join(root, "no-such-folder"),
            environment: {},
            logPath,
            onLine: (line) => lines.push(line),
        });

        expect(status).toBe(1);
        expect(readFileSync(logPath, "utf8")).toContain("true did not start");
        expect(lines.some((line) => line.includes("did not start"))).toBe(true);
    });
});

describe("summary", () => {
    const spec = { name: "agents.flow", path: "specs/agents.flow.spec.ts", file: "/p/specs/agents.flow.spec.ts" };
    const passed = { suite: "Agents flow", title: "loads", state: "passed" as const, durationMs: 10 };
    const failed = { ...passed, title: "lists", state: "failed" as const, error: "expected [] got [x]\nstack" };
    const summary = (tests: E2eTestResult[], runDir: string): RunSummary => {
        const specs = [
            {
                spec,
                dir: "/d",
                exitCode: tests.some((test) => test.state === "failed") ? 1 : 0,
                seconds: 3,
                log: "/d/runner.log",
                tests,
            },
        ];
        return {
            project: "shop",
            runner: "wdio",
            runDir,
            startedAt: "2026-11-04T21:00:00Z",
            finishedAt: "2026-11-04T21:01:00Z",
            facts: { device: "gt-w402 (SIM-1, iOS 26.5)" },
            specs,
            counts: countResults(specs),
            notes: [],
            ok: false,
        };
    };

    it("fails a spec that exited non-zero, failed a test, or ran none, and writes markdown", () => {
        expect(specFailed({ exitCode: 0, tests: [passed] })).toBe(false);
        expect(specFailed({ exitCode: 1, tests: [passed] })).toBe(true);
        expect(specFailed({ exitCode: 0, tests: [] })).toBe(true);
        const markdown = formatSummary(summary([passed, failed], "/runs/b"));
        expect(markdown).toContain("- Device: gt-w402 (SIM-1, iOS 26.5)");
        expect(markdown).toContain("- FAIL agents.flow: 1/2 passed, exit 1");
        expect(markdown).toContain("    - Agents flow > lists: expected [] got [x]");
    });

    it("names the tests that changed between two runs, new failures first", () => {
        const before = summary([passed, { ...failed, state: "passed" as const }], "/runs/a");
        const after = summary([{ ...passed, state: "failed" as const }], "/runs/b");
        expect(compareRuns(before, after)).toEqual([
            { test: "specs/agents.flow.spec.ts > Agents flow > loads", before: "passed", after: "failed" },
            { test: "specs/agents.flow.spec.ts > Agents flow > lists", before: "passed", after: "absent" },
        ]);
        expect(stamp(new Date(2026, 10, 4, 21, 5, 33))).toBe("2026-11-04T21-05-33");
    });
});

it("finishes later specs and writes a summary after a truncated result line", async () => {
    const project = fixtureProject("truncated-results");
    const runDir = join(root, "truncated-run");
    let finished = false;
    const summary = await runE2e({
        project,
        specs: listSpecs(project).slice(0, 2),
        runDir,
        flags: {},
        extraEnv: {},
        prepare: async () => ({
            facts: {},
            environment: {},
            command: () => [
                process.execPath,
                "-e",
                `
                const line = process.env.E2E_SPEC.includes("agents") ? '{"title":' : JSON.stringify({suite:"s", title:"later", state:"passed", durationMs:1});
                require("node:fs").writeFileSync(process.env.E2E_RESULTS_FILE, line + "\\n");
            `,
            ],
            finish: async () => {
                finished = true;
                return [];
            },
        }),
    });
    expect(finished).toBe(true);
    expect(summary.specs).toHaveLength(2);
    expect(summary.specs[0].tests[0]).toMatchObject({ state: "failed", title: "Invalid result line 1" });
    expect(summary.specs[1].tests[0].state).toBe("passed");
    expect(summary.counts.specsFailed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(existsSync(join(runDir, "summary.json"))).toBe(true);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
});

it("reads a results line that parses but is not a test record as a failed test", () => {
    const path = join(root, "invalid-records.jsonl");
    const valid = '{"suite":"s","title":"ok","state":"passed","durationMs":1}';
    writeFileSync(path, ["{}", "null", '{"suite":"s","title":"t","state":"done","durationMs":1}', valid].join("\n"));
    const results = readResults(path);
    expect(results.map((result) => result.title)).toEqual([
        "Invalid result line 1",
        "Invalid result line 2",
        "Invalid result line 3",
        "ok",
    ]);
    expect(results.slice(0, 3).every((result) => result.state === "failed")).toBe(true);
    expect(specFailed({ exitCode: 0, tests: readResults(path).slice(0, 1) })).toBe(true);
});

it("selects completed run summaries while ignoring newer screen captures", () => {
    const history = runsRoot("history-fixture");
    for (const name of ["2026-01-01", "2026-01-02", "2026-01-03-capture", "2026-01-04-incomplete"]) {
        mkdirSync(join(history, name), { recursive: true });
    }
    for (const name of ["2026-01-01", "2026-01-02"]) {
        writeFileSync(join(history, name, "summary.json"), "{}");
    }
    writeFileSync(join(history, "2026-01-03-capture", "screen.png"), "fixture");
    expect(listRunDirs("history-fixture")).toEqual([join(history, "2026-01-02"), join(history, "2026-01-01")]);
});

it("starts device logging only after preparation succeeds and stops it at finish", async () => {
    const project = fixtureProject("wdio-preparation");
    const runDir = join(root, "wdio-preparation-run");
    mkdirSync(runDir, { recursive: true });
    const config = mobileProject.parseMobileConfig(
        {
            id: "shop",
            platforms: {
                ios: {
                    bundleId: "com.example.shop",
                    build: {
                        workspace: "ios/Shop.xcworkspace",
                        scheme: "Shop",
                        configuration: "Debug",
                        productName: "Shop",
                    },
                },
            },
        },
        join(project.dir, "mobile.config.ts")
    );
    const child = new childProcess.ChildProcess();
    const spawn = spyOn(childProcess, "spawn").mockReturnValue(child);
    const kill = spyOn(child, "kill").mockReturnValue(true);
    const status = spyOn(mobileAppium, "appiumStatus").mockRejectedValue(new Error("fixture-status-failure"));
    const mocks = [
        spawn,
        kill,
        status,
        spyOn(mobileProject, "loadMobileProject").mockResolvedValue({
            config,
            configPath: join(project.dir, "mobile.config.ts"),
            appDir: project.dir,
        }),
        spyOn(mobileSession, "pickSimulator").mockResolvedValue({
            udid: "fixture-device",
            name: "Fixture",
            state: "Booted",
            runtime: "fixture",
            osVersion: "1.0",
            isAvailable: true,
        }),
        spyOn(mobileSession, "requireAppInstalled").mockResolvedValue(undefined),
        spyOn(mobileSession, "ensureAppium").mockResolvedValue(4777),
        spyOn(mobileSimulator, "simulatorUiRunning").mockResolvedValue(false),
        spyOn(mobileSimulator, "installedAppInfo").mockResolvedValue(null),
    ];
    const prepare = () =>
        RUNNERS.wdio.prepare({
            project,
            runner: { kind: "wdio", config: "wdio.conf.ts" },
            flags: { alertWatcher: false },
            runDir,
        });
    try {
        await expect(prepare()).rejects.toThrow("fixture-status-failure");
        expect(spawn).not.toHaveBeenCalled();
        status.mockResolvedValue({
            port: 4777,
            answers: true,
            version: "1",
            owned: "none",
            pid: null,
            log: join(root, "missing-appium.log"),
        });
        const target = await prepare();
        expect(spawn).toHaveBeenCalledTimes(1);
        await target.finish();
        expect(kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
        for (const mock of mocks) {
            mock.mockRestore();
        }
    }
});

it("discovers only summary-bearing suite runs, excluding later screen captures", () => {
    const folder = runsRoot("fixture-report-discovery");
    mkdirSync(join(folder, "2026-11-05T10-00-00"), { recursive: true });
    mkdirSync(join(folder, "2026-11-05T11-00-00"), { recursive: true });
    writeFileSync(join(folder, "2026-11-05T10-00-00", "summary.json"), "{}");
    expect(listRunDirs("fixture-report-discovery")).toEqual([join(folder, "2026-11-05T10-00-00")]);
});

it("recognizes an existing single-component relative run directory", async () => {
    const folder = join(root, "artifacts");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "summary.json"), "{}");
    const previous = process.cwd();
    try {
        process.chdir(root);
        expect(realpathSync(await runDirOf({}, "artifacts"))).toBe(realpathSync(folder));
    } finally {
        process.chdir(previous);
    }
});
