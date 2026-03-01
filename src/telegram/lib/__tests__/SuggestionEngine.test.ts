import { describe, expect, it, spyOn } from "bun:test";
import { assistantEngine } from "../AssistantEngine";
import { SuggestionEngine } from "../SuggestionEngine";

describe("SuggestionEngine", () => {
    it("extracts and trims suggestion lines", async () => {
        const engine = new SuggestionEngine();
        const askSpy = spyOn(assistantEngine, "ask").mockResolvedValue(
            "1. First option\n- Second option\nThird option"
        );

        const options = await engine.generateSuggestions({
            sessionId: "s1",
            mode: {
                enabled: true,
                provider: "openai",
                model: "gpt-4o-mini",
                count: 3,
                trigger: "manual",
                autoDelayMs: 0,
                allowAutoSend: false,
            },
            incomingText: "How are you?",
        });

        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(options).toEqual(["First option", "Second option", "Third option"]);
    });
});
