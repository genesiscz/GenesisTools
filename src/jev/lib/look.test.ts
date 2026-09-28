import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { chooseOcrTarget, type OcrBlock, readOcrBlocks } from "./look";

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

function block(text: string, confidence = 1): { text: string; confidence: number; px: OcrBlock["px"] } {
    return { text, confidence, px: { x: 1, y: 2, w: 3, h: 4 } };
}

function choosing(choice: string): Evaluator {
    return async (call) => {
        const request = evaluationSchema.parse(call.input);
        const question = request.questions.target;

        if (question?.type !== "choice") {
            throw new Error("expected a choice question");
        }

        const keys = Object.keys(question.criteria);
        const rest = (1 - 0.85) / (keys.length - 1);
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.85 : rest]));

        return evaluation({
            target: { type: "choice", choice, probabilities },
        });
    };
}

test("readOcrBlocks drops low confidence text and assigns ids", () => {
    const blocks = readOcrBlocks({
        ok: true,
        blocks: [block("Pokračovat"), block("noise", 0.5), block("  ")],
    });

    expect(blocks.map((item) => item.id)).toEqual(["b1"]);
    expect(blocks[0]?.text).toBe("Pokračovat");
});

test("an exact text match does not call the model", async () => {
    const blocks = readOcrBlocks({ ok: true, blocks: [block("Pokračovat"), block("Více info")] });
    const result = await chooseOcrTarget({
        blocks,
        intent: "pokračovat",
        evaluate: async () => {
            throw new Error("model should not run");
        },
    });

    expect(result.status).toBe("resolved");
    expect(result.source).toBe("exact");
    expect(result.selected?.id).toBe("b1");
});

test("jev chooses one region and can abstain", async () => {
    const blocks = readOcrBlocks({ ok: true, blocks: [block("Love Island"), block("Pokračovat"), block("SuperStar")] });
    const hit = await chooseOcrTarget({ blocks, intent: "resume Love Island", evaluate: choosing("b2") });

    expect(hit.status).toBe("resolved");
    expect(hit.selected?.text).toBe("Pokračovat");
    expect(hit.source).toBe("jev");

    const miss = await chooseOcrTarget({ blocks, intent: "resume Love Island", evaluate: choosing("abstain") });

    expect(miss.status).toBe("abstained");
    expect(miss.selected).toBeNull();
});

test("no text abstains without a model call", async () => {
    const result = await chooseOcrTarget({
        blocks: [],
        intent: "play",
        evaluate: async () => {
            throw new Error("model should not run");
        },
    });

    expect(result).toMatchObject({ status: "abstained", selected: null, source: "exact" });
});
