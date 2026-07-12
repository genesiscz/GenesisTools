import { describe, expect, it } from "bun:test";
import { toLanguageModelUsage, usageCacheWriteTokens } from "@ask/utils/helpers";

describe("toLanguageModelUsage", () => {
    it("round-trips cacheWriteTokens from flat usage into inputTokenDetails", () => {
        const usage = toLanguageModelUsage({
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            cachedInputTokens: 200,
            cacheWriteTokens: 50,
        });

        expect(usage.inputTokenDetails?.cacheWriteTokens).toBe(50);
        expect(usageCacheWriteTokens(usage)).toBe(50);
    });

    it("defaults cacheWriteTokens to 0 when omitted from flat usage", () => {
        const usage = toLanguageModelUsage({
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
        });

        expect(usage.inputTokenDetails?.cacheWriteTokens).toBeUndefined();
        expect(usageCacheWriteTokens(usage)).toBe(0);
    });
});
