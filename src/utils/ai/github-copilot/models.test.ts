import { describe, expect, it } from "bun:test";
import { formatCopilotUsageSummary, toProxyId } from "@app/utils/ai/github-copilot/models";

describe("github-copilot models", () => {
    it("builds proxy model ids", () => {
        expect(toProxyId("genesiscz", "claude-sonnet-4")).toBe("genesiscz/github-copilot/claude-sonnet-4");
    });

    it("formats usage summary from quota snapshots", () => {
        const summary = formatCopilotUsageSummary({
            quota_snapshots: {
                chat: {
                    quota_remaining: 42,
                    percent_remaining: 70,
                },
            },
        });

        expect(summary).toBe("Copilot chat quota: 42 remaining (70% left)");
    });
});
