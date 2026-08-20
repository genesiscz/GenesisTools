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

    it("matches thinkingRules on User-Agent, first match wins", () => {
        const rules = [
            { uaRegex: "Cursor", mode: "cursor" as const },
            { catchAll: true, mode: "auto" as const },
        ];

        expect(resolveThinkingMode({ configMode: "folded", rules, userAgent: "Cursor/1.0" })).toBe("cursor");
        // "auto" resolves to raw on the chat door: untouched upstream bytes.
        // The cursor reshape is Cursor-specific and only comes from a UA match.
        expect(resolveThinkingMode({ configMode: "folded", rules, userAgent: "Bun/1.3.14" })).toBe("raw");
    });

    it("keeps header and flag above the rules, and falls back to config without them", () => {
        const rules = [{ catchAll: true, mode: "cursor" as const }];

        expect(resolveThinkingMode({ configMode: "raw", rules, userAgent: "curl/8", headerMode: "folded" })).toBe(
            "folded"
        );
        expect(resolveThinkingMode({ configMode: "raw", rules, userAgent: "curl/8", flagMode: "folded" })).toBe(
            "folded"
        );
        // A config without thinkingRules behaves exactly as before.
        expect(resolveThinkingMode({ configMode: "folded", userAgent: "Cursor/1.0" })).toBe("folded");
    });

    it("skips an invalid uaRegex instead of throwing", () => {
        const rules = [
            { uaRegex: "(", mode: "raw" as const },
            { catchAll: true, mode: "cursor" as const },
        ];

        expect(resolveThinkingMode({ configMode: "folded", rules, userAgent: "anything" })).toBe("cursor");
    });

    it("validates thinking modes", () => {
        expect(isValidThinkingMode("raw")).toBe(true);
        expect(isValidThinkingMode("cursor")).toBe(true);
        expect(isValidThinkingMode("folded")).toBe(true);
        expect(isValidThinkingMode("blocks")).toBe(false);
    });
});
