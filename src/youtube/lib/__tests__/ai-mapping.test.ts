import { describe, expect, it } from "bun:test";
import { resolveAiSpecForTask, specOfAiMapping } from "@app/youtube/lib/ai-mapping";

const specExample = {
    ai: [
        {
            provider: "xai",
            model: "grok-4-fast-reasoning",
            for: ["insights", "summary"] as Array<"insights" | "summary">,
        },
        { provider: "xai", model: "grok-4-fast-non-reasoning", for: ["all"] as Array<"all"> },
    ],
    provider: { summarize: "openai/gpt-5" },
};

describe("resolveAiSpecForTask", () => {
    it("prefers the explicit task entry", () => {
        expect(resolveAiSpecForTask(specExample, "insights")).toBe("xai/grok-4-fast-reasoning");
        expect(resolveAiSpecForTask(specExample, "summary")).toBe("xai/grok-4-fast-reasoning");
    });

    it("falls back to the 'all' entry when the task has no explicit entry", () => {
        expect(resolveAiSpecForTask(specExample, "qa")).toBe("xai/grok-4-fast-non-reasoning");
        expect(resolveAiSpecForTask(specExample, "embed")).toBe("xai/grok-4-fast-non-reasoning");
    });

    it("falls back to legacy provider.* strings when ai[] is empty", () => {
        const legacyOnly = { ai: [], provider: { summarize: "openai/gpt-5", qa: "anthropic" } };

        expect(resolveAiSpecForTask(legacyOnly, "summary")).toBe("openai/gpt-5");
        expect(resolveAiSpecForTask(legacyOnly, "insights")).toBe("openai/gpt-5");
        expect(resolveAiSpecForTask(legacyOnly, "qa")).toBe("anthropic");
    });

    it("returns null when nothing is configured", () => {
        expect(resolveAiSpecForTask({ ai: [], provider: {} }, "transcribe")).toBeNull();
    });

    it("supports provider-only entries", () => {
        expect(resolveAiSpecForTask({ ai: [{ provider: "xai", for: ["all"] }], provider: {} }, "qa")).toBe("xai");
        expect(specOfAiMapping({ provider: "xai", for: ["all"] })).toBe("xai");
    });
});
