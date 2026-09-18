import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { screenFiles } from "./batch";
import { changedFiles } from "./changed";
import { SCREEN_PURPOSES } from "./templates";
import { parseClaims, verifyClaims } from "./verify";

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

test("purpose list includes secrets", () => {
    expect(SCREEN_PURPOSES).toContain("secrets");
    expect(SCREEN_PURPOSES).toContain("focus-safety");
});

test("screen batches 21 files into two evaluate calls and never asks for a comment", async () => {
    let calls = 0;
    const evaluate: Evaluator = async (call) => {
        calls += 1;
        const request = evaluationSchema.parse(call.input);
        expect(SafeJSON.stringify(request.questions)).not.toContain("write a review");
        const answers: EvaluationResponse["answers"] = {};
        for (const id of Object.keys(request.questions)) {
            answers[id] = { type: "boolean", probability: id.includes("risky") ? 0.9 : 0.1 };
        }
        return evaluation(answers);
    };
    const files = Array.from({ length: 21 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        text: "export const x = 1;",
    }));
    const result = await screenFiles({ files, purpose: "focus-safety", evaluate });
    expect(result.batches).toBe(2);
    expect(result.scores).toHaveLength(21);
    expect(result.scores[0]?.answers.risky).toBe(0.9);
    expect(calls).toBe(2);
});

test("verify claims returns per-id answers", async () => {
    const evaluate: Evaluator = async () =>
        evaluation({
            c0_supported: { type: "boolean", probability: 0.95 },
            c0_contradicted: { type: "boolean", probability: 0.01 },
            c0_sensitive: { type: "boolean", probability: 0.8 },
        });
    const claims = parseClaims('[{"id":"c0","text":"this includes alice@example.com"}]');
    const result = await verifyClaims({ claims, against: "src/", evaluate });
    expect(result.scores[0]).toEqual({ id: "c0", supported: 0.95, contradicted: 0.01, sensitive: 0.8 });
});

test("only-changed keeps paths from git diff --name-only", () => {
    expect(changedFiles("src", () => "src/jev/lib/screen/verify.ts\nREADME.md\n")).toEqual([
        "src/jev/lib/screen/verify.ts",
    ]);
});
