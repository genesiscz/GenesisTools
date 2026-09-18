import { expect, test } from "bun:test";
import { join } from "node:path";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { buildCatalogue, flattenCatalogue, isDestructive } from "./catalogue";
import { extractArgHints, routeUtterance } from "./router";

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
