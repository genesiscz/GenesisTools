import { describe, expect, it } from "bun:test";
import { isValidThinkingMode, normalizeThinkingMode, resolveThinkingMode } from "@app/ai-proxy/lib/thinking-config";

describe("thinking-config", () => {
    it("normalizes raw and cursor aliases", () => {
        expect(normalizeThinkingMode("RAW")).toBe("raw");
        expect(normalizeThinkingMode("cursor")).toBe("cursor");
        expect(normalizeThinkingMode("blocks")).toBe("cursor");
        expect(normalizeThinkingMode("folded")).toBe("folded");
        expect(normalizeThinkingMode("details")).toBe("folded");
        expect(normalizeThinkingMode("invalid")).toBeNull();
    });

    it("resolves header over flag over config", () => {
        expect(
            resolveThinkingMode({
                configMode: "raw",
                flagMode: "cursor",
                headerMode: "raw",
            })
        ).toBe("raw");

        expect(
            resolveThinkingMode({
                configMode: "raw",
                flagMode: "cursor",
            })
        ).toBe("cursor");

        expect(
            resolveThinkingMode({
                configMode: "raw",
            })
        ).toBe("raw");
    });

    it("validates thinking modes", () => {
        expect(isValidThinkingMode("raw")).toBe(true);
        expect(isValidThinkingMode("cursor")).toBe(true);
        expect(isValidThinkingMode("folded")).toBe(true);
        expect(isValidThinkingMode("blocks")).toBe(false);
    });
});
