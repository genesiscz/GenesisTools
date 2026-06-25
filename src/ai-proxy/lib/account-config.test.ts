import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    migrateAccountConfig,
    resolveGithubCopilotDataDir,
    resolveGrokAuthPath,
} from "@app/ai-proxy/lib/account-config";
import { parseConfigJson } from "@app/ai-proxy/lib/config-store";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

const baseAccount: AiProxyAccountConfig = {
    name: "genesiscz",
    provider: "grok-subscription",
    providerSlug: "grok",
    enabled: true,
};

describe("account-config", () => {
    it("resolves grok auth path from nested config", () => {
        const account: AiProxyAccountConfig = {
            ...baseAccount,
            grok: { authPath: join(tmpdir(), "grok", "auth.json") },
        };

        expect(resolveGrokAuthPath(account)).toBe(join(tmpdir(), "grok", "auth.json"));
    });

    it("migrates legacy flat grok and copilot fields", () => {
        const migrated = migrateAccountConfig({
            ...baseAccount,
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            grokAuthPath: "/legacy/grok.json",
            copilotDataDir: "/legacy/copilot",
            copilotAccountType: "business",
        });

        expect(migrated.grok).toEqual({ authPath: "/legacy/grok.json" });
        expect(migrated.githubCopilot).toEqual({ dataDir: "/legacy/copilot", type: "business" });
        expect("grokAuthPath" in migrated).toBe(false);
        expect("copilotDataDir" in migrated).toBe(false);
        expect("copilotAccountType" in migrated).toBe(false);
    });

    it("resolves github copilot data dir from nested config", () => {
        const account: AiProxyAccountConfig = {
            ...baseAccount,
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            githubCopilot: { dataDir: join(tmpdir(), "copilot-api") },
        };

        expect(resolveGithubCopilotDataDir(account)).toBe(join(tmpdir(), "copilot-api"));
    });

    it("migrates legacy fields when parsing config json", () => {
        const config = parseConfigJson(
            '{"accounts":[{"name":"genesiscz","provider":"grok-subscription","providerSlug":"grok","enabled":true,"grokAuthPath":"/old/auth.json"}]}'
        );

        expect(config.accounts[0]?.grok).toEqual({ authPath: "/old/auth.json" });
        expect("grokAuthPath" in (config.accounts[0] ?? {})).toBe(false);
    });
});
