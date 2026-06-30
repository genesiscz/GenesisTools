import { describe, expect, it } from "bun:test";
import { inferModelThinking } from "@app/utils/ai/grok/models";

describe("inferModelThinking", () => {
    it("returns none for non-reasoning model ids instead of matching the broader reasoning regex", () => {
        expect(inferModelThinking("grok-4-1-fast-non-reasoning")).toBe("none");
    });

    it("still returns reasoning for ids that genuinely indicate reasoning", () => {
        expect(inferModelThinking("grok-4-1-reasoning")).toBe("reasoning");
        expect(inferModelThinking("grok-build")).toBe("reasoning");
    });
});
