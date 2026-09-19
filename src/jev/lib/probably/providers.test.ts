import { describe, expect, test } from "bun:test";
import { ModelResolutionError } from "@genesiscz/utils/ai/core/resolve";
import type { EvaluationResponse } from "@genesiscz/utils/ai/evaluation/providers";
import { createProbablyProvider } from "./providers";
import { run } from "./runtime";

function choiceResponse(probabilities: Record<string, number>): EvaluationResponse {
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "option_0";
    return {
        model: "fixture-jev",
        answers: {
            decision: {
                type: "choice",
                choice,
                probabilities,
            },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        providerMetadata: undefined,
        warnings: undefined,
        rounding: undefined,
    } as unknown as EvaluationResponse;
}

describe("createProbablyProvider", () => {
    test("maps Jev option_* probabilities onto Probably labels", async () => {
        let seenCriteria: Record<string, string> | undefined;
        const provider = createProbablyProvider({
            evaluate: async (call) => {
                const decision = (call.input as { questions: { decision: { criteria: Record<string, string> } } })
                    .questions.decision;
                seenCriteria = decision.criteria;
                return choiceResponse({ option_0: 0.91, option_1: 0.09 });
            },
            chat: async () => {
                throw new Error("Unexpected generation");
            },
        });

        const result = await run(
            'if input() feels "urgent" with confidence 80% {print("yes")} otherwise maybe {print("maybe")} else {print("no")}',
            provider,
            { input: "drop everything" }
        );

        expect(seenCriteria).toEqual({ option_0: "urgent", option_1: "NOT: urgent" });
        expect(result.output).toEqual(["yes"]);
        expect(result.tape).toHaveLength(1);
        expect(result.tape[0].kind).toBe("judge");
    });

    test("llm/write uses injected chat and only the using context", async () => {
        let chatCalls = 0;
        const provider = createProbablyProvider({
            evaluate: async () => {
                throw new Error("Unexpected judgment");
            },
            chat: async (options) => {
                chatCalls += 1;
                expect(options.systemPrompt).toContain("writing instruction");
                expect(options.userPrompt).toContain('"instruction":"shorten"');
                expect(options.userPrompt).toContain('"context":"long draft"');
                expect(options.app).toBe("jev");
                expect(options.task).toBe("chat");
                return { content: "  short draft  " };
            },
        });

        const result = await run('let draft = llm "shorten" using input()\nprint(draft)', provider, {
            input: "long draft",
        });

        expect(chatCalls).toBe(1);
        expect(result.output).toEqual(["short draft"]);
        expect(result.tape.map((effect) => effect.kind)).toEqual(["write"]);
    });

    test("judge then write in one program uses both doors", async () => {
        let judged = 0;
        let written = 0;
        const provider = createProbablyProvider({
            evaluate: async () => {
                judged += 1;
                return choiceResponse({ option_0: 0.9, option_1: 0.1 });
            },
            chat: async () => {
                written += 1;
                return { content: "rewritten once" };
            },
        });

        const result = await run(
            `let draft = input()
if draft feels "urgent" with confidence 80% {
  draft = llm "shorten" using draft
  print(draft)
} else {
  print("no")
}`,
            provider,
            { input: "drop everything now" }
        );

        expect({ judged, written, output: result.output }).toEqual({
            judged: 1,
            written: 1,
            output: ["rewritten once"],
        });
    });

    test("missing chat default becomes a Probably-specific error", async () => {
        const provider = createProbablyProvider({
            chat: async () => {
                throw new ModelResolutionError('No default account for task "chat"');
            },
            evaluate: async () => {
                throw new Error("Unexpected judgment");
            },
        });

        await expect(run('print(llm "hi")', provider)).rejects.toThrow(/Pass --model/);
    });
});
