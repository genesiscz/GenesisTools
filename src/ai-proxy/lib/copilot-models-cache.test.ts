import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import type { CopilotModelRecord } from "@app/utils/ai/github-copilot/types";

const probeCopilotModels = mock(
    async (): Promise<CopilotModelRecord[]> => [
        { id: "claude-sonnet-4.6", source: "live", description: "Claude Sonnet 4.6" },
        { id: "gpt-5.4", source: "live", description: "GPT-5.4" },
    ]
);

mock.module("@app/utils/ai/github-copilot/probe-models", () => ({
    probeCopilotModels,
}));

const { clearCopilotModelsCache, resolveCopilotModelRecords } = await import("@app/ai-proxy/lib/copilot-models-cache");

const account: AiProxyAccountConfig = {
    name: "genesiscz",
    provider: "github-copilot-subscription",
    providerSlug: "github-copilot",
    enabled: true,
    githubCopilot: { type: "individual" },
};

describe("copilot-models-cache", () => {
    afterEach(() => {
        clearCopilotModelsCache();
        probeCopilotModels.mockClear();
    });

    it("probes live models from the Copilot API", async () => {
        const models = await resolveCopilotModelRecords(account);

        expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4.6", "gpt-5.4"]);
        expect(probeCopilotModels).toHaveBeenCalledTimes(1);
    });

    it("reuses cached probe results within TTL", async () => {
        await resolveCopilotModelRecords(account);
        await resolveCopilotModelRecords(account);

        expect(probeCopilotModels).toHaveBeenCalledTimes(1);
    });
});
