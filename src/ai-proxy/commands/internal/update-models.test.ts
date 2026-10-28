import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { captureOutput } from "@genesiscz/utils/test/capture-out";

setupStorageSandbox();

const scratch = mkdtempSync(join(tmpdir(), "gt-update-models-"));

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

const grokAuth = join(scratch, "grok", "auth.json");
const copilotDir = join(scratch, "copilot");
let accounts: AiProxyAccountConfig[] = [];

mock.module("@app/ai-proxy/lib/config", () => ({
    loadConfig: async () => ({
        listen: { host: "127.0.0.1", port: 8317 },
        proxyApiKey: "aipx-fixture-0123456789",
        translation: { cursorAgent: "auto", thinking: "cursor" },
        accounts,
    }),
}));

const { runUpdateModelsCommand } = await import("@app/ai-proxy/commands/internal/update-models");
const { catalogFilePath } = await import("@app/ai-proxy/lib/catalog-file");

const grok: AiProxyAccountConfig = {
    name: "grok",
    provider: "grok-subscription",
    providerSlug: "grok",
    enabled: true,
    grok: { authPath: grokAuth },
};
const copilot: AiProxyAccountConfig = {
    name: "copilot",
    provider: "github-copilot-subscription",
    providerSlug: "github-copilot",
    enabled: true,
    githubCopilot: { dataDir: copilotDir },
};
const xai: AiProxyAccountConfig = { name: "xai", provider: "xai-api-key", providerSlug: "xai", enabled: true };

describe("runUpdateModelsCommand per provider type", () => {
    it("probes the Grok and Copilot accounts only, each through its own login", async () => {
        accounts = [grok, copilot, xai];

        const { stderr } = await captureOutput(() => runUpdateModelsCommand({ dryRun: true }));

        expect(stderr).toContain(`Skipping grok: no auth at ${grokAuth}`);
        expect(stderr).toContain(`Skipping copilot: no GitHub token at ${copilotDir}`);
        expect(stderr).toContain(`Would write ${catalogFilePath()} (0 account(s))`);
        expect(stderr).not.toContain("xai");
    });

    it("refuses a config whose accounts have no catalog probe", async () => {
        accounts = [xai];

        const { stderr } = await captureOutput(() => runUpdateModelsCommand({ dryRun: true }));

        expect(stderr).toContain("No matching grok or github-copilot accounts in config");
    });
});
