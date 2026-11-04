import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2eProject } from "@genesiscz/utils/e2e/project";
import { E2E_ENV, type E2eTestResult } from "@genesiscz/utils/e2e/spec-env";
import { stamp } from "./paths";
import { runE2e } from "./run";
import { RUNNERS, runnerFlags } from "./runners";
import { listSpecs, resolveSpecs, specName, suiteSpecs } from "./specs";
import { compareRuns, countResults, formatSummary, type RunSummary, specFailed } from "./summary";

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
        const target = await RUNNERS.playwright.prepare({
            project,
            runner: { kind: "playwright", config: "playwright.config.ts", baseUrl: "http://127.0.0.1:5173" },
            flags: { baseUrl: "http://127.0.0.1:4000" },
            runDir: "/runs/x",
        });
        const [spec] = listSpecs(project);

        expect(target.environment).toEqual({ [E2E_ENV.baseUrl]: "http://127.0.0.1:4000" });
        const command = target.command(spec, "/runs/x/agents.flow");
        expect(command.slice(0, 4)).toEqual(["bunx", "playwright", "test", spec.file]);
        expect(command.find((part) => part.startsWith("--reporter="))).toMatch(
            /^--reporter=list,.*playwright-reporter\.ts$/
        );
        expect(existsSync(command.find((part) => part.startsWith("--reporter="))?.split(",")[1] ?? "")).toBe(true);
        expect(command).toContain("--output=/runs/x/agents.flow/artifacts");
    });
});

describe("run loop", () => {
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
        expect(existsSync(join(runDir, "agents.flow", "runner.log"))).toBe(true);
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
            { test: "agents.flow > Agents flow > loads", before: "passed", after: "failed" },
            { test: "agents.flow > Agents flow > lists", before: "passed", after: "absent" },
        ]);
        expect(stamp(new Date(2026, 10, 4, 21, 5, 33))).toBe("2026-11-04T21-05-33");
    });
});
