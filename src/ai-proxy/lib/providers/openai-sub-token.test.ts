import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { codexOAuth } from "@genesiscz/utils/ai/openai/codex-auth";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";

const ORIGINAL_HOME = env.get("GENESIS_TOOLS_HOME");

function fixtureToken(expiresAt: number, label: string): string {
    return `e30.${Buffer.from(SafeJSON.stringify({ exp: Math.floor(expiresAt / 1000), fixture: label, "https://api.openai.com/auth": { chatgpt_account_id: "workspace-test" } })).toString("base64url")}.fixture`;
}

function writeAiConfig(home: string): void {
    const aiDir = join(home, ".genesis-tools", "ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(
        join(aiDir, "config.json"),
        SafeJSON.stringify(
            {
                _schemaVersion: 3,
                accounts: [
                    {
                        name: "codex-test",
                        provider: "openai-sub",
                        tokens: {
                            accessToken: fixtureToken(Date.now() - 60_000, "stale"),
                            refreshToken: "refresh-0",
                            expiresAt: Date.now() - 60_000, // expired → needs refresh
                        },
                    },
                ],
            },
            null,
            2
        )
    );
}

const PROXY_ACCOUNT: AiProxyAccountConfig = {
    name: "proxy-codex",
    provider: "openai-subscription",
    providerSlug: "codex",
    enabled: true,
    openaiSub: { accountName: "codex-test" },
};

describe("resolveOpenAiSubToken — single-flight refresh", () => {
    let tempHome: string;

    beforeEach(async () => {
        tempHome = mkdtempSync(join(tmpdir(), "openai-sub-token-"));
        env.testing.set("GENESIS_TOOLS_HOME", tempHome);
        const key = Buffer.alloc(32, 21);
        _setMasterKeyProvidersForTest([
            { id: "env", available: async () => true, get: async () => key, getSync: () => key, set: async () => {} },
        ]);
        _resetSecretsForTest();
        writeAiConfig(tempHome);
        AIConfig.invalidate();
        // Prime the singleton (and run migrations) serially so the two concurrent
        // resolves race only inside withLock, not inside AIConfig.load().
        await AIConfig.load();
    });

    afterEach(() => {
        AIConfig.invalidate();
        mock.restore();
        _resetMasterKeyProviders();
        _resetSecretsForTest();

        if (ORIGINAL_HOME === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", ORIGINAL_HOME);
        }
    });

    it("refreshes a single-use Codex token only once under concurrent resolves", async () => {
        let refreshCount = 0;
        const freshAccess = fixtureToken(Date.now() + 3_600_000, "fresh");
        const refreshSpy = spyOn(codexOAuth, "refresh").mockImplementation(async () => {
            refreshCount += 1;
            // Hold the lock long enough that the second resolve is still waiting.
            await new Promise((resolve) => setTimeout(resolve, 25));

            return {
                accessToken: freshAccess,
                refreshToken: `refresh-${refreshCount}`,
                expiresAt: Date.now() + 3_600_000,
            };
        });

        const [first, second] = await Promise.all([
            resolveOpenAiSubToken(PROXY_ACCOUNT),
            resolveOpenAiSubToken(PROXY_ACCOUNT),
        ]);

        // Second resolve must observe the already-refreshed token, not POST the
        // same single-use refresh token a second time.
        expect(refreshSpy).toHaveBeenCalledTimes(1);
        expect(first.token).toBe(freshAccess);
        expect(second.token).toBe(freshAccess);
    });
});
