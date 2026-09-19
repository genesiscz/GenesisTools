import { describe, expect, test } from "bun:test";
import { skip } from "@genesiscz/utils/test/skip";
import { createProbablyProvider } from "./providers";
import { run } from "./runtime";

/**
 * Live doors for the Probably lab. Off unless RUN_LIVE=1.
 * Judge uses tools jev / TypeSafe. Write uses ai.chat; pass PROBABLY_WRITE_MODEL
 * (default xai/grok-4-fast) when no chat task default is configured.
 */
describe.skipIf(skip.live)("createProbablyProvider live", () => {
    const writeModel = process.env.PROBABLY_WRITE_MODEL || "xai/grok-4-fast";

    test("Jev judges an urgent message", async () => {
        const provider = createProbablyProvider({ provider: "typesafe" });
        const result = await run(
            'if input() feels "genuinely urgent" with confidence 80% { print("yes") } otherwise maybe { print("maybe") } else { print("no") }',
            provider,
            {
                input: "The presentation is in 10 minutes and every slide says INSERT STRATEGY HERE.",
            }
        );

        expect(result.tape).toHaveLength(1);
        expect(result.tape[0].kind).toBe("judge");
        expect(["yes", "maybe", "no"]).toContain(result.output[0]);
        // This fixture is strongly urgent; abstain/no would mean the live door regressed.
        expect(result.output[0]).toBe("yes");
    }, 60_000);

    test("ai.chat rewrites through llm/write", async () => {
        const provider = createProbablyProvider({ provider: "typesafe", model: writeModel });
        const result = await run(
            'let draft = llm "Reply with exactly two words: hello world" using input()\nprint(draft)',
            provider,
            {
                input: "ignored context",
            }
        );

        expect(result.tape.map((effect) => effect.kind)).toEqual(["write"]);
        expect(result.output).toHaveLength(1);
        expect(result.output[0].toLowerCase()).toContain("hello");
    }, 60_000);
});
