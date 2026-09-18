import { expect, test } from "bun:test";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { parseCompactJsonl } from "./format";
import { compactWithJev } from "./llm";
import { compactStructural } from "./structural";

const defaults = { keep: 0.5, pin: 2, maxResult: 20, threshold: 0.25 };

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

test("user and assistant text survive structural compaction", () => {
    const text = [
        `{"role":"user","content":"please review 409"}`,
        `{"role":"assistant","content":"looking"}`,
        `{"role":"tool","name":"github","content":"${"hunk".repeat(40)}"}`,
        `{"role":"user","content":"keep this tail"}`,
        `{"role":"assistant","content":"ok"}`,
    ].join("\n");
    const result = compactStructural(parseCompactJsonl(text), defaults);
    const joined = result.lines.join("\n");
    expect(joined).toContain("please review 409");
    expect(joined).toContain("looking");
    expect(joined).toContain("keep this tail");
    expect(result.unchanged === true || result.reduction >= 0).toBe(true);
});

test("below-threshold reduction returns the original session", () => {
    const text = [`{"role":"user","content":"short"}`, `{"role":"assistant","content":"also short"}`].join("\n");
    const result = compactStructural(parseCompactJsonl(text), { ...defaults, threshold: 0.25 });
    expect(result.unchanged).toBe(true);
    expect(result.reason).toBe("below_threshold");
    expect(result.lines.join("\n")).toContain("short");
});

test("invalid JSONL lines are kept verbatim", () => {
    const text = 'not-json\n{"role":"user","content":"ok"}';
    const messages = parseCompactJsonl(text);
    expect(messages[0]?.raw).toBe("not-json");
    expect(messages[1]?.roleKind).toBe("user");
});

test("Jev layer applies keep/drop without rewriting user text", async () => {
    const text = [
        `{"role":"user","content":"stay"}`,
        `{"role":"tool","name":"github","content":"${"x".repeat(80)}"}`,
        `{"role":"assistant","content":"done"}`,
        `{"role":"user","content":"tail"}`,
        `{"role":"assistant","content":"tail2"}`,
    ].join("\n");
    const evaluate: Evaluator = async () =>
        evaluation({
            t1: {
                type: "choice",
                choice: "drop",
                probabilities: { keep_both: 0.01, keep_call_truncate_result: 0.01, drop: 0.98 },
            },
        });
    const result = await compactWithJev({
        messages: parseCompactJsonl(text),
        evaluate,
        structural: { keep: 0.1, pin: 2, maxResult: 10, threshold: 0.01 },
    });
    expect(result.lines.join("\n")).toContain("stay");
    expect(result.decisions.some((decision) => decision.kind === "drop" || decision.reason === "jev")).toBe(true);
});
