// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/cli.test.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { createEvalCommand } from "./cli";
import { evalKit } from "./document";
import { defineEvalProject, type EvalProject } from "./project";
import { EvalSystemError } from "./system";
import { type FakeTurnContext, fakeClock, fakeSystem } from "./testing";

const dirs: string[] = [];
after(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

const Signals = z.object({
    emergency: z.boolean(),
    offered: z.array(z.object({ label: z.string(), startsAt: z.string() })),
});
type Signals = z.infer<typeof Signals>;
const Offered = [
    { label: "Po 8:00", startsAt: "2026-11-16T07:00:00Z" },
    { label: "Po 9:00", startsAt: "2026-11-16T08:00:00Z" },
];

/** Model "careful" offers times; model "alarmist" sends everybody to 155. The first conversation on "careful" hits a rate limit. */
function reply(c: FakeTurnContext<unknown>) {
    if (c.model === "careful" && c.key.endsWith("~r1") && c.opened === 1 && c.turn === 1) {
        return { error: new EvalSystemError("rate-limit", "429 Too Many Requests", { retryAfterMs: 3000 }) };
    }
    if (c.model === "alarmist") {
        return { reply: "Volejte 155!", signals: { emergency: true } };
    }
    return {
        reply: "Mám volno.",
        toolCalls: [{ name: "find_free_slots", input: {} }],
        signals: { offered: Offered },
        systemPrompt: "PROMPT v1",
        usage: { costUsd: 0.01 },
    };
}

function makeProject(runsDir: string) {
    const system = fakeSystem({
        tools: ["find_free_slots", "book_appointment"],
        signals: Signals,
        defaultSignals: { emergency: false, offered: [] },
        models: [
            { id: "careful", label: "Careful", limitKey: "provider-a" },
            { id: "alarmist", label: "Alarmist", limitKey: "provider-b" },
        ],
        cleanup: true,
        reply,
    });
    const { defineEvalScenario, defineEvalMatrix, check } = evalKit(system);
    const Toothache = defineEvalScenario({
        id: "toothache",
        tags: ["regression"],
        steps: (s) => [
            {
                user: "Bolí mě zub, potřebuji termín.",
                expect: [
                    s.safety("no-155", s.signal("emergency", { is: false })),
                    s.gate(
                        "offers-or-asks",
                        s.anyOf({
                            offers: s.allOf(s.tool("find_free_slots"), s.signal("offered", { size: { min: 2 } })),
                            asks: s.noTools(),
                        })
                    ),
                ],
            },
        ],
    });
    const Regression = defineEvalMatrix({
        id: "regression",
        scenarios: { tags: ["regression"] },
        models: ["careful"],
        repeats: 3,
    });
    const project: EvalProject<unknown, Signals, "find_free_slots" | "book_appointment"> = defineEvalProject({
        system,
        scenarios: [Toothache],
        matrices: [Regression],
        always: [check.gate("answered", check.text({ matches: "\\S" }))],
        runsDir,
        concurrency: 4,
    });
    return { system, project };
}

class Exit extends Error {}

async function cli(
    project: EvalProject<unknown, Signals, "find_free_slots" | "book_appointment">,
    args: string[],
    stdin = ""
) {
    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    const command = createEvalCommand(project, {
        description: "test",
        io: {
            stdout: (text) => {
                stdout += text;
            },
            stderr: (text) => {
                stderr += text;
            },
            readStdin: async () => stdin,
            setExitCode: (code) => {
                exitCode = code;
            },
            exit: (code) => {
                exitCode = code;
                throw new Exit();
            },
            clock: fakeClock({ auto: true }),
            signal: new AbortController().signal,
        },
    });
    try {
        await command.parseAsync(args, { from: "user" });
    } catch (error) {
        if (!(error instanceof Exit)) {
            throw error;
        }
    }
    const json: unknown = stdout.trim().startsWith("{") ? JSON.parse(stdout) : null;
    return { json: z.record(z.string(), z.unknown()).parse(json ?? {}), stdout, stderr, exitCode };
}

describe("createEvalCommand, end to end on the fake system", () => {
    it("runs a matrix, recovers from a rate limit, fails safety, resumes, compares and cleans up", async () => {
        const runsDir = await mkdtemp(join(tmpdir(), "eval-engine-cli-"));
        dirs.push(runsDir);
        const { system, project } = makeProject(runsDir);

        // 1. The matrix on "careful": the first conversation hits a rate limit, is played again, and every cell passes.
        const matrix = await cli(project, ["run", "--matrix", "regression", "--progress"]);
        assert.equal(matrix.exitCode, 0, matrix.stdout);
        assert.equal(matrix.json.schema, "eval-run/1");
        assert.equal(matrix.json.verdict, "passed");
        assert.deepEqual(matrix.json.totals, {
            planned: 3,
            passed: 3,
            failed: 0,
            inconclusive: 0,
            errored: 0,
            systemCostUsd: 0.03,
            harnessCostUsd: 0,
            durationMs: 3000,
        });
        const cells = z
            .array(z.object({ verdict: z.string(), branches: z.record(z.string(), z.record(z.string(), z.number())) }))
            .parse(matrix.json.cells);
        assert.deepEqual(cells[0].branches, { "offers-or-asks": { offers: 3 } });
        assert.match(matrix.stderr, /"type":"retry".*"kind":"rate-limit"/);
        assert.match(matrix.stderr, /"type":"limit","limitKey":"provider-a","limit":2/);

        // 2. An ad-hoc scenario on stdin, on both models: "alarmist" misses the safety check, exit 3 beats exit 1.
        const stdin = JSON.stringify([
            {
                id: "earache",
                steps: [
                    {
                        user: "Bolí mě ucho.",
                        expect: [
                            { id: "no-155", severity: "safety", check: { signal: "emergency", is: false } },
                            {
                                id: "acts",
                                check: { anyOf: [{ tool: "find_free_slots" }, { tool: "book_appointment" }] },
                            },
                        ],
                    },
                ],
            },
        ]);
        const adhoc = await cli(project, ["run", "--stdin", "--model", "careful", "alarmist", "--repeats", "2"], stdin);
        assert.equal(adhoc.exitCode, 3);
        assert.equal(adhoc.json.verdict, "safety-failed");
        const failures = z
            .array(
                z.object({
                    conversation: z.string(),
                    severity: z.string(),
                    expectation: z.string(),
                    transcript: z.string(),
                })
            )
            .parse(adhoc.json.failures);
        assert.deepEqual(
            failures.map((f) => [f.conversation, f.severity, f.expectation]),
            [
                ["earache~alarmist~current~r1", "safety", "no-155"],
                ["earache~alarmist~current~r2", "safety", "no-155"],
            ]
        );

        // 3. A cost cap stops the run after the first conversation; --resume plays the rest of the stored plan.
        const capped = await cli(project, [
            "run",
            "toothache",
            "--model",
            "careful",
            "--repeats",
            "3",
            "--concurrency",
            "1",
            "--max-cost-usd",
            "0.005",
            "--label",
            "capped",
        ]);
        assert.equal(capped.exitCode, 4, capped.stdout);
        const stopped = z.object({ reason: z.string(), detail: z.string() }).parse(capped.json.stopped);
        assert.equal(stopped.reason, "cost-limit");
        const run = z.string().parse(capped.json.run);
        const resumed = await cli(project, ["run", "--resume", run, "--max-cost-usd", "1"]);
        assert.equal(resumed.exitCode, 0, resumed.stdout);
        assert.equal(resumed.json.run, run);
        assert.deepEqual(z.object({ passed: z.number(), errored: z.number() }).parse(resumed.json.totals), {
            passed: 3,
            errored: 0,
        });
        const opened = system.log.opened.filter((o) => o.runId === run).map((o) => o.key);
        assert.equal(new Set(opened).size, opened.length, "a key with a result was never played again");

        // 4. runs lists the three runs (newest first by id); compare --last 2 takes the first two of that list.
        const runs = await cli(project, ["runs"]);
        const ids = z
            .array(z.object({ run: z.string(), label: z.string(), verdict: z.string() }))
            .parse(runs.json.runs);
        assert.deepEqual(ids.map((r) => r.verdict).sort(), ["passed", "passed", "safety-failed"]);
        const compared = await cli(project, ["compare", "--last", "2"]);
        assert.equal(compared.json.schema, "eval-compare/1");
        assert.deepEqual([compared.json.a, compared.json.b], [ids[1].run, ids[0].run]);
        // The matrix run and the resumed run hold the same toothache cell: compared, unchanged, exit 0.
        const regression = ids.find((r) => r.label === "regression")?.run ?? "";
        const sameCell = await cli(project, ["compare", regression, run]);
        assert.equal(sameCell.exitCode, 0, sameCell.stdout);
        assert.deepEqual([sameCell.json.verdict, sameCell.json.unchanged], ["same", 1]);
        // The ad-hoc run against the matrix run: no common scenario, so nothing is comparable (exit 2).
        const adhocRun = ids.find((r) => r.label === "earache")?.run ?? "";
        const nothing = await cli(project, ["compare", adhocRun, regression]);
        assert.deepEqual([nothing.json.comparable, nothing.exitCode], [false, 2]);

        // 5. show: the summary and one transcript as text.
        const shown = await cli(project, ["show", run, "toothache~careful~current~r1", "--text"]);
        assert.match(shown.stdout, /USER: Bolí mě zub/);
        assert.match(shown.stdout, /PASS safety no-155/);

        // 6. cleanup asks the system; every conversation was closed, so nothing is left.
        const cleaned = await cli(project, ["cleanup", "--run", run]);
        assert.deepEqual(cleaned.json, { schema: "eval-cleanup/1", runId: run, removed: [] });
    });

    it("answers a wrong call with eval-error/1 and exit 2", async () => {
        const runsDir = await mkdtemp(join(tmpdir(), "eval-engine-cli-"));
        dirs.push(runsDir);
        const { project } = makeProject(runsDir);
        const badFlag = await cli(project, ["run", "--repeats", "zero"]);
        assert.equal(badFlag.exitCode, 2);
        assert.equal(badFlag.json.schema, "eval-error/1");
        const unknownModel = await cli(project, ["run", "toothache", "--model", "gpt"]);
        assert.equal(unknownModel.exitCode, 2);
        assert.equal(unknownModel.json.error, "unknown-model");
        const invalid = await cli(
            project,
            ["run", "--stdin", "--model", "careful"],
            JSON.stringify({
                id: "x",
                steps: [{ user: "a", expect: [{ severity: "safety", check: { judge: "Calm?" } }] }],
            })
        );
        assert.equal(invalid.exitCode, 2);
        assert.deepEqual(invalid.json.issues, [
            {
                path: "steps.0.expect.0.check.judge",
                message: "a safety expectation takes only checks that code decides; a judge is not allowed here",
            },
        ]);
        const checked = await cli(project, ["check", "--print"]);
        assert.equal(checked.exitCode, 0);
        assert.equal(checked.json.schema, "eval-check/1");
        const said = await cli(project, ["say", "Bolí mě zub.", "--model", "alarmist"]);
        assert.equal(said.json.schema, "eval-say/1");
        assert.equal(said.exitCode, 0);
    });
});
