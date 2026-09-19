import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { registerDemoReel } from "../../commands/demo-reel";
import { createFixtureEvaluator, fullDistribution } from "./fixture-evaluator";
import { recordReel } from "./record";
import { DEMO_NAMES, type DemoTrace, parseDemoName, refuseUserMail, runDemo, runReel, writeReelSummary } from "./reel";

/** A clock that only moves when it is read, so every `atMs` is deterministic and nothing sleeps. */
function fakeClock(stepMs = 10): () => number {
    let value = Date.UTC(2026, 8, 18, 12, 0, 0);
    return () => {
        value += stepMs;
        return value;
    };
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
    const dir = join("/tmp", `jev-demo-test-${name}-${Bun.nanoseconds()}`);
    temporaryDirectories.push(dir);
    return dir;
}

afterAll(async () => {
    await Promise.all(temporaryDirectories.map((dir) => Bun.$`rm -rf ${dir}`.quiet().catch(() => undefined)));
});

test("every chapter runs its real lib function and confirms its own readback", async () => {
    const result = await runReel({ now: fakeClock() });
    const red = result.chapters.filter((chapter) => !chapter.ok).map((chapter) => `${chapter.demo}: ${chapter.reason}`);
    expect(red).toEqual([]);
    expect(result.chapters.map((chapter) => chapter.demo)).toEqual([...DEMO_NAMES]);
    expect(result.ok).toBe(true);
    for (const chapter of result.chapters) {
        expect({ demo: chapter.demo, requests: chapter.requests > 0 }).toEqual({ demo: chapter.demo, requests: true });
        expect(chapter.readback).toBe(true);
        expect(chapter.events.length).toBeGreaterThan(1);
    }
});

test("a chapter whose Jev call throws is red, which proves every chapter really calls Jev", async () => {
    const throwing: Evaluator = async () => {
        throw new Error("no paid evaluator in the demo reel");
    };
    const result = await runReel({ now: fakeClock(), evaluator: () => throwing });
    expect(result.chapters.filter((chapter) => chapter.ok)).toEqual([]);
    expect(result.failed).toBe(DEMO_NAMES.length);
    for (const chapter of result.chapters) {
        expect(chapter.readback).toBe(false);
        expect(chapter.reason).toContain("no paid evaluator");
    }
});

test("an unhelpful Jev abstains and the decision chapters go red instead of fabricating success", async () => {
    const abstaining = createFixtureEvaluator({}).evaluate;
    for (const demo of ["listen", "voice", "observe", "loop", "watch", "route"] as const) {
        const trace = await runDemo(demo, { now: fakeClock(), evaluator: () => abstaining });
        expect({ demo, ok: trace.ok, readback: trace.readback }).toEqual({ demo, ok: false, readback: false });
    }
});

test("the loop chapter goes red when Jev never says the goal is done", async () => {
    const stuck = createFixtureEvaluator({
        choice: [
            [/^target$/, /Export/],
            [/^verb$/, /^press$/],
        ],
        boolean: [[/^done$/, 0.05]],
        score: [[/^risk$/, 0]],
    }).evaluate;
    const trace = await runDemo("loop", { now: fakeClock(), evaluator: () => stuck });
    expect(trace.ok).toBe(false);
    expect(trace.reason).toContain("stopped");
});

test("the verify chapter goes red when the secrets gate does not fire", async () => {
    const open = createFixtureEvaluator({ boolean: [[/.*/, 0.01]] }).evaluate;
    const trace = await runDemo("verify", { now: fakeClock(), evaluator: () => open });
    expect(trace.ok).toBe(false);
    expect(trace.reason).toContain("block=false");
});

test("--dir writes one artifact per chapter plus reel.json, and loop.json carries a real trace", async () => {
    const dir = temporaryDirectory("reel");
    const result = await runReel({ now: fakeClock(), dir });
    await writeReelSummary(dir, result);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(
        [...DEMO_NAMES]
            .map((name) => `${name}.json`)
            .sort()
            .concat("reel.json")
            .sort()
    );
    expect(files).toHaveLength(DEMO_NAMES.length + 1);

    const loop = SafeJSON.parse(await Bun.file(join(dir, "loop.json")).text());
    const trace = (loop as { result?: { trace?: unknown[] } }).result?.trace ?? [];
    expect(trace.length).toBeGreaterThan(1);
    expect((loop as { artifact?: string }).artifact).toBe(join(dir, "loop.json"));

    const summary = SafeJSON.parse(await Bun.file(join(dir, "reel.json")).text());
    expect((summary as { failed?: number }).failed).toBe(0);
});

test("--dir is honoured on either side of the reel subcommand name", async () => {
    for (const argv of [
        (dir: string) => ["control", "demo", "reel", "--dir", dir],
        (dir: string) => ["control", "demo", "--dir", dir, "reel"],
    ]) {
        const dir = temporaryDirectory("argv");
        const program = new Command().name("tools jev");
        registerDemoReel(program);
        await program.parseAsync(argv(dir), { from: "user" });
        expect(await readdir(dir)).toHaveLength(DEMO_NAMES.length + 1);
    }
});

test("the trace keeps its schema and derives ok from readback alone", async () => {
    const trace: DemoTrace = await runDemo("route", { now: fakeClock() });
    expect(Object.keys(trace).sort()).toEqual(
        ["demo", "events", "ok", "readback", "reason", "requests", "startedAt"].sort()
    );
    expect(trace.startedAt).toBe("2026-09-18T12:00:00.010Z");
    expect(trace.events[0]).toMatchObject({ atMs: expect.any(Number), kind: "catalogue" });
    expect(trace.ok).toBe(trace.readback);
});

test("unknown chapter names are rejected", () => {
    expect(() => parseDemoName("fly")).toThrow(/Unknown demo/);
    expect(parseDemoName("watch")).toBe("watch");
});

test("Mail is refused without the break-glass flag", () => {
    expect(() => refuseUserMail("Mail")).toThrow(/Mail/);
    expect(() => refuseUserMail("Mail", true)).not.toThrow();
    expect(() => refuseUserMail("ControlFixture")).not.toThrow();
});

test("--record reports the real reason instead of a blanket 'capture skipped'", async () => {
    const outcome = await recordReel({ dir: "/tmp", platform: "linux" });
    expect(outcome.ok).toBe(false);
    expect(outcome.record).toBe("skipped: screen capture needs macOS, this is linux");
});

const EVALUATION_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@genesiscz\/utils\/ai\/evaluation[^"]*"/g;

test("no demo module imports a value from the evaluation service, so none can spend money", async () => {
    const files = await readdir(import.meta.dir, { recursive: true });
    const sources = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of sources) {
        const text = await Bun.file(join(import.meta.dir, file)).text();
        for (const match of text.matchAll(EVALUATION_IMPORT)) {
            const typeOnly =
                match[1] !== undefined ||
                (match[2] ?? "")
                    .split(",")
                    .map((binding) => binding.trim())
                    .filter(Boolean)
                    .every((binding) => binding.startsWith("type "));
            if (!typeOnly) {
                offenders.push(`${file}: ${match[0]}`);
            }
        }
    }

    expect(offenders).toEqual([]);
});

test("a fixture distribution covers exactly the request's own options and sums to one", () => {
    const distribution = fullDistribution(["c0", "c1", "abstain"], "c0", 0.96);
    expect(Object.keys(distribution).sort()).toEqual(["abstain", "c0", "c1"]);
    expect(Object.values(distribution).reduce((total, value) => total + value, 0)).toBeCloseTo(1, 10);
    expect(fullDistribution(["only"], "only", 0.96)).toEqual({ only: 1 });
});
