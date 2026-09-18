import { expect, test } from "bun:test";
import { join } from "node:path";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { buildCatalogue, flattenCatalogue, isDestructive } from "./catalogue";
import { extractArgHints, fillArgv, routeUtterance, suggestBatches, suggestCatalogue } from "./router";

function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

test("catalogue includes jev and control and marks control act destructive", () => {
    const catalogue = buildCatalogue(join(import.meta.dir, "..", "..", ".."));
    const names = catalogue.tools.map((tool) => tool.name);
    expect(names).toContain("jev");
    expect(names).toContain("control");
    expect(isDestructive("control act")).toBe(true);
    const flat = flattenCatalogue(catalogue);
    expect(flat.some((row) => row.path.startsWith("control"))).toBe(true);
    expect(flat.length).toBeGreaterThan(10);
});

test("router prints a command and does not invent flags", async () => {
    const catalogue = {
        commit: "test",
        tools: [
            {
                name: "github",
                oneLine: "GitHub pull requests",
                commands: [{ path: "github review", description: "review", argHint: "<n>", destructive: false }],
            },
        ],
    };
    const evaluate: Evaluator = async () =>
        evaluation({
            command: {
                type: "choice",
                choice: "github.review",
                probabilities: { "github.review": 0.96, abstain: 0.04 },
            },
            destructive: { type: "boolean", probability: 0.01 },
            confirm: { type: "boolean", probability: 0.02 },
        });
    const result = await routeUtterance({
        utterance: "unresolved review threads on 409",
        catalogue,
        evaluate,
    });
    expect(result.status).toBe("resolved");
    expect(result.printed).toBe("tools github review 409");
    expect(result.argv).toEqual(["review", "409"]);
    expect(result.destructive).toBe(false);
});

test("unknown utterances abstain", async () => {
    const evaluate: Evaluator = async () =>
        evaluation({
            command: { type: "choice", choice: "abstain", probabilities: { "github.review": 0.1, abstain: 0.9 } },
            destructive: { type: "boolean", probability: 0 },
            confirm: { type: "boolean", probability: 0 },
        });
    const result = await routeUtterance({
        utterance: "what is the weather",
        catalogue: {
            commit: "test",
            tools: [
                {
                    name: "github",
                    oneLine: "GitHub",
                    commands: [{ path: "github review", description: "review", argHint: "", destructive: false }],
                },
            ],
        },
        evaluate,
    });
    expect(result.status).toBe("abstained");
});

test("extractArgHints copies issue numbers", () => {
    expect(extractArgHints("threads on 409")).toEqual(["409"]);
});

test("suggest batches at most 20 names", () => {
    const batches = suggestBatches(
        Array.from({ length: 41 }, (_, index) => index),
        20
    );
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(20);
    expect(batches[2]).toHaveLength(1);
});

test("github rows carry alias descriptions", () => {
    const rows = flattenCatalogue({
        commit: "test",
        tools: [
            {
                name: "github",
                oneLine: "GitHub pull requests",
                commands: [{ path: "github review", description: "review", argHint: "<n>", destructive: false }],
            },
        ],
    });
    expect(rows[0]?.oneLine).toContain("aliases: pr, review");
});

test("fillArgv does not invent a missing path", () => {
    expect(fillArgv("open missing-file.ts on 409", ["review"], () => false)).toEqual(["review", "409"]);
    expect(fillArgv("open present.ts", ["review"], (path) => path === "present.ts")).toEqual(["review", "present.ts"]);
});

test("suggest ranks a 20-name batch", async () => {
    const tools = Array.from({ length: 21 }, (_, index) => ({
        name: `tool${index}`,
        oneLine: `Tool ${index}`,
        commands: [{ path: `tool${index} run`, description: "run", argHint: "", destructive: false }],
    }));
    const evaluate: Evaluator = async (call) => {
        const ids = Object.keys(evaluationSchema.parse(call.input).questions);
        expect(ids.length).toBeLessThanOrEqual(20);
        return evaluation(
            Object.fromEntries(ids.map((id) => [id, { type: "score" as const, score: id.includes("tool0") ? 2 : 0 }]))
        );
    };
    const result = await suggestCatalogue({
        utterance: "run tool0",
        catalogue: { commit: "test", tools },
        evaluate,
    });
    expect(result[0]?.path).toBe("tool0 run");
    expect(result).toHaveLength(10);
});
