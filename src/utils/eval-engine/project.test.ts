// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/project.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { EvalConfigError, evalKit } from "./document";
import { checkEval, defineEvalProject, loadScenarios, runEval, sayEval } from "./project";
import { loadRun } from "./store";
import { EvalSystemError } from "./system";
import { fakeClock, fakeSystem } from "./testing";

const dirs: string[] = [];
after(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "eval-engine-project-"));
    dirs.push(dir);
    return dir;
}

const Setup = z.object({
    clock: z.enum(["Real", "MondayMorning"]).default("MondayMorning"),
    at: z.string().optional(),
});
const Signals = z.object({ ok: z.boolean() });

function system(options: { failKey?: string } = {}) {
    return fakeSystem({
        tools: ["t"],
        setup: Setup,
        signals: Signals,
        defaultSignals: { ok: true },
        // The clock anchor becomes an instant once, when the run is planned.
        resolveSetup: (setup, { now }) => ({ ...setup, at: setup.clock === "Real" ? undefined : now.toISOString() }),
        reply: (c) =>
            c.key === options.failKey ? { error: new EvalSystemError("transient", "502") } : { reply: "ok" },
    });
}

describe("loading scenario files", () => {
    it("collects every exported scenario of *.eval.ts files, validated again", async () => {
        const dir = await tempDir();
        await writeFile(
            join(dir, "a.eval.ts"),
            `type Doc = { kind: "eval-scenario"; doc: unknown };\nexport const First: Doc = { kind: "eval-scenario", doc: { id: "first", steps: [{ user: "hi" }] } };\nexport const List: Doc[] = [{ kind: "eval-scenario", doc: { id: "second", steps: [{ user: "yo" }] } }];\nexport const NotAScenario = 3;\n`
        );
        await writeFile(
            join(dir, "helpers.ts"),
            `export const Ignored = { kind: "eval-scenario", doc: { id: "ignored", steps: [{ user: "x" }] } };\n`
        );
        const kit = evalKit(system());
        const project = defineEvalProject({
            system: system(),
            scenarios: { dir },
            matrices: [],
            always: [kit.check.gate("ok", kit.check.signal("ok", { is: true }))],
        });
        const scenarios = await loadScenarios(project);
        assert.deepEqual(
            scenarios.map((s) => s.doc.id),
            ["first", "second"]
        );
        assert.deepEqual(
            scenarios[0].doc.always.map((e) => e.id),
            ["ok"]
        );
    });

    it("names the file and export of an invalid scenario", async () => {
        const dir = await tempDir();
        await writeFile(
            join(dir, "b.eval.ts"),
            `export const Bad = { kind: "eval-scenario", doc: { id: "bad", steps: [{ user: "x", expect: [{ check: { tool: "nope" } }] }] } };\n`
        );
        await assert.rejects(
            loadScenarios(defineEvalProject({ system: system(), scenarios: { dir }, matrices: [] })),
            (e: unknown) => {
                return e instanceof EvalConfigError && e.issues[0].path === "b.eval.ts:Bad.steps.0.expect.0.check.tool";
            }
        );
    });
});

describe("runEval", () => {
    it("resolves each setup once at plan time, stores it, and reuses it on resume", async () => {
        const runsDir = await tempDir();
        const kit = evalKit(system());
        const scenario = kit.defineEvalScenario({ id: "s", steps: [{ user: "hi" }] });
        const clock = fakeClock({ auto: true, start: Date.UTC(2026, 10, 10, 9) });
        const first = system({ failKey: "s~fake~current~r2" });
        const project = defineEvalProject({ system: first, scenarios: [scenario], matrices: [], runsDir });
        const summary = await runEval(project, { scenarios: [scenario], models: ["fake"], repeats: 2 }, { clock });
        assert.equal(summary.exitCode, 4);
        const planned = new Date(Date.UTC(2026, 10, 10, 9)).toISOString();
        assert.deepEqual(
            first.log.opened.map((o) => o.setup),
            [
                { clock: "MondayMorning", at: planned },
                { clock: "MondayMorning", at: planned },
                { clock: "MondayMorning", at: planned },
                { clock: "MondayMorning", at: planned },
            ]
        );
        const view = await loadRun(summary.run, runsDir);
        assert.deepEqual(view.manifest.setups, { s: { clock: "MondayMorning", at: planned } });

        const later = fakeClock({ auto: true, start: Date.UTC(2026, 11, 24, 9) });
        const second = system();
        const resumed = await runEval(
            defineEvalProject({ system: second, scenarios: [scenario], matrices: [], runsDir }),
            { resume: summary.run },
            { clock: later }
        );
        assert.equal(resumed.exitCode, 0);
        assert.deepEqual(
            second.log.opened.map((o) => [o.key, o.setup, o.runId]),
            [["s~fake~current~r2", { clock: "MondayMorning", at: planned }, summary.run]]
        );
    });

    it("refuses cross-project resume before setup resolution, connection or persistent writes", async () => {
        const runsDir = await tempDir();
        const first = system({ failKey: "s~fake~current~r2" });
        const scenario = evalKit(first).defineEvalScenario({ id: "s", steps: [{ user: "hi" }] });
        const summary = await runEval(
            defineEvalProject({ system: first, scenarios: [scenario], matrices: [], runsDir }),
            { scenarios: [scenario], models: ["fake"], repeats: 2 },
            { clock: fakeClock({ auto: true }) }
        );
        assert.equal(summary.exitCode, 4);
        const before = await loadRun(summary.run, runsDir);
        const other = system();
        let resolutions = 0;
        let connections = 0;
        const foreign = {
            ...other,
            name: "another-project",
            resolveSetup: (...args: Parameters<typeof other.resolveSetup>) => {
                resolutions += 1;
                return other.resolveSetup(...args);
            },
            connect: (...args: Parameters<typeof other.connect>) => {
                connections += 1;
                return other.connect(...args);
            },
        };
        await assert.rejects(
            runEval(defineEvalProject({ system: foreign, scenarios: [scenario], matrices: [], runsDir }), {
                resume: summary.run,
            }),
            (error: unknown) =>
                error instanceof EvalConfigError && error.code === "plan-changed" && /project/.test(error.message)
        );
        assert.equal(resolutions, 0);
        assert.equal(connections, 0);
        assert.equal(other.log.opened.length, 0);
        assert.deepEqual(await loadRun(summary.run, runsDir), before);
    });

    it("refuses a resume when the signals version changed", async () => {
        const runsDir = await tempDir();
        const kit = evalKit(system());
        const scenario = kit.defineEvalScenario({ id: "s", steps: [{ user: "hi" }] });
        const summary = await runEval(
            defineEvalProject({ system: system(), scenarios: [scenario], matrices: [], runsDir }),
            { scenarios: [scenario], models: ["fake"] },
            { clock: fakeClock({ auto: true }) }
        );
        const bumped = { ...system(), signalsVersion: 2 };
        await assert.rejects(
            runEval(defineEvalProject({ system: bumped, scenarios: [scenario], matrices: [], runsDir }), {
                resume: summary.run,
            }),
            (e: unknown) =>
                e instanceof EvalConfigError && e.code === "plan-changed" && /signals version 1 → 2/.test(e.message)
        );
    });

    it("checks models, variants and the simulator against the live system", async () => {
        const kit = evalKit(system());
        const scenario = kit.defineEvalScenario({
            id: "sim",
            steps: [{ simulate: { persona: "p", goal: "g", maxTurns: 2 } }],
        });
        const project = defineEvalProject({
            system: system(),
            scenarios: [scenario],
            matrices: [],
            runsDir: await tempDir(),
        });
        await assert.rejects(
            runEval(project, { scenarios: [scenario], models: ["gpt"] }),
            (e: unknown) => e instanceof EvalConfigError && e.code === "unknown-model" && /known: fake/.test(e.message)
        );
        await assert.rejects(
            runEval(project, { scenarios: [scenario], models: ["fake"], variants: ["v9"] }),
            (e: unknown) => e instanceof EvalConfigError && e.code === "unknown-variant"
        );
        await assert.rejects(runEval(project, { scenarios: [scenario], models: ["fake"] }), /simulated step/);
    });
});

it("say bounds simultaneous open handles", async () => {
    const fake = system();
    const connect = fake.connect;
    let live = 0;
    let peak = 0;
    fake.connect = (target) => {
        const connection = connect(target);
        const open = connection.open;
        const close = connection.close;
        return {
            ...connection,
            open: async (request) => {
                peak = Math.max(peak, ++live);
                return open(request);
            },
            close: async (handle, outcome) => {
                await close(handle, outcome);
                live--;
            },
        };
    };
    const result = await sayEval(
        defineEvalProject({ system: fake, scenarios: [], matrices: [] }),
        { texts: ["hi"], model: "fake", repeats: 10 },
        { concurrency: 2 }
    );
    assert.equal(result.conversations.length, 10);
    assert.equal(peak, 2);
    assert.equal(live, 0);
});

it("refuses to invent the unknown default variant during offline matrix check", () => {
    const project = defineEvalProject({ system: system(), scenarios: [], matrices: [] });
    assert.throws(
        () => checkEval(project, [], { matrix: { id: "m", scenarios: "all", models: ["fake"], repeats: 1 } }),
        /explicit variants/
    );
});
