import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ToolCatalogue } from "../route/catalogue";
import { compactRequest, observeRequest, routeRequest, verifyRequest, watchRequest } from "./api";

/**
 * One fixture evaluator for every route, in the shape 409's replay routes use: it reads the
 * questions the lib actually asked and answers by type, so a lib that adds a question does not
 * silently get an empty answer.
 */
function fixtureEvaluator(prefer: string): Evaluator {
    return async (call) => {
        const input = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(input.questions)) {
            if (question.type === "boolean") {
                answers[id] = { type: "boolean", probability: id.includes("supported") ? 0.93 : 0.02 };
            } else if (question.type === "score") {
                answers[id] = { type: "score", score: 0.1 };
            } else {
                const keys = Object.keys(question.criteria ?? {});
                const choice = keys.includes(prefer) ? prefer : (keys.find((key) => key !== "abstain") ?? "abstain");
                const rest = keys.length > 1 ? (1 - 0.95) / (keys.length - 1) : 0;
                answers[id] = {
                    type: "choice",
                    choice,
                    probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.95 : rest])),
                };
            }
        }

        return {
            model: "fixture",
            answers,
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
            warnings: [],
            rounding: undefined,
            providerMetadata: undefined,
        };
    };
}

const catalogue: ToolCatalogue = {
    commit: "fixture",
    tools: [
        {
            name: "github",
            oneLine: "Read GitHub issues and pull requests",
            commands: [
                {
                    path: "github review",
                    description: "Read the review threads of one pull request",
                    argHint: "<pr>",
                    destructive: false,
                    flags: [],
                    flagsLoaded: true,
                    hasSubcommands: false,
                },
            ],
        },
        {
            name: "port",
            oneLine: "List listening ports",
            commands: [
                {
                    path: "port list",
                    description: "List the listening ports on this machine",
                    argHint: "",
                    destructive: false,
                    flags: [],
                    flagsLoaded: true,
                    hasSubcommands: false,
                },
            ],
        },
    ],
};

const BIG = "hunk-".repeat(200);
const SESSION_JSONL = [
    SafeJSON.stringify({ role: "system", content: "You are a helper." }, { jsonl: true }),
    SafeJSON.stringify({ role: "user", content: "list the files" }, { jsonl: true }),
    SafeJSON.stringify(
        { role: "assistant", content: "running ls", toolCalls: [{ id: "c1", name: "bash", input: "ls", result: BIG }] },
        { jsonl: true }
    ),
    SafeJSON.stringify({ role: "assistant", content: "file7 is largest" }, { jsonl: true }),
    SafeJSON.stringify({ role: "user", content: "thanks" }, { jsonl: true }),
].join("\n");

test("POST /route returns the CLI's own decision and never an execution", async () => {
    const decision = await routeRequest({
        input: { utterance: "read the review threads of pull request 409" },
        provider: "vercel",
        evaluate: fixtureEvaluator("github.review"),
        catalogue,
    });
    expect(decision.status).toBe("admitted");
    expect(decision.command).toBe("github review");
    expect(decision.argv.slice(0, 3)).toEqual(["tools", "github", "review"]);
    expect(decision.printed).toContain("tools github review");
    expect(decision.requests).toBeGreaterThan(0);
});

test("POST /route rejects an empty utterance", async () => {
    await expect(
        routeRequest({ input: { utterance: "" }, provider: "vercel", evaluate: fixtureEvaluator("abstain"), catalogue })
    ).rejects.toThrow();
});

test("POST /compact returns the structural result and its decision table", async () => {
    const result = await compactRequest({ input: { text: SESSION_JSONL, keep: 0.5, maxResult: 40 } });
    expect(result.format).toBe("generic-jsonl");
    expect(result.counts.sourceBytes).toBe(Buffer.byteLength(SESSION_JSONL, "utf8"));
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.table.length).toBe(result.decisions.length);
    expect(result.lines.join("\n")).toContain("file7 is largest");
});

test("POST /verify scores every claim against the text", async () => {
    const result = await verifyRequest({
        input: {
            claims: "The release notes name version 4.2.\nThe release notes mention a Windows build.",
            against: "Release 4.2 ships the new scheduler. Linux and macOS builds are attached.",
            purposes: ["accuracy"],
        },
        provider: "vercel",
        evaluate: fixtureEvaluator("abstain"),
    });
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0].id).toBe("c1");
    expect(result.claims[0].supported).toBeCloseTo(0.93, 2);
    expect(result.missingAnswers).toEqual([]);
    expect(result.gate.block).toBe(false);
    expect(result.purposes).toEqual(["accuracy"]);
});

test("POST /observe fans out over the retained fixture observation", async () => {
    const fanout = await observeRequest({
        input: { goal: "Press the seven key." },
        provider: "vercel",
        evaluate: fixtureEvaluator("c0"),
    });
    expect(fanout.target?.id).toBe("c0");
    expect(fanout.target?.label).toBe("7");
    expect(fanout.verb).toBe("press");
    expect(fanout.status).toBe("act");
});

test("POST /observe refuses an unknown fixture id", async () => {
    await expect(
        observeRequest({
            input: { caseId: "not-a-case", goal: "Press the seven key." },
            provider: "vercel",
            evaluate: fixtureEvaluator("abstain"),
        })
    ).rejects.toThrow(/Unknown control fixture/);
});

test("POST /watch ticks on the fixture driver and stops on its own budget", async () => {
    const result = await watchRequest({
        input: { goal: "The calculator shows seven.", hz: 10, seconds: 0.3, maxRequests: 1 },
        provider: "vercel",
        evaluate: fixtureEvaluator("c0"),
    });
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.observes).toBe(result.ticks);
    expect(result.hz).toBe(10);
    expect(["stopped", "verified"]).toContain(result.status);
});
