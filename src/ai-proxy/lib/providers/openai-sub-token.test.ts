import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { codexOAuth } from "@app/utils/ai/openai/codex-auth";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

const ORIGINAL_HOME = env.get("GENESIS_TOOLS_HOME");

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
                            accessToken: "stale-access",
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
        writeAiConfig(tempHome);
        AIConfig.invalidate();
        // Prime the singleton (and run migrations) serially so the two concurrent
        // resolves race only inside withLock, not inside AIConfig.load().
        await AIConfig.load();
    });

    afterEach(() => {
        AIConfig.invalidate();
        mock.restore();

        if (ORIGINAL_HOME === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", ORIGINAL_HOME);
        }
    });

    it("refreshes a single-use Codex token only once under concurrent resolves", async () => {
        let refreshCount = 0;
        const refreshSpy = spyOn(codexOAuth, "refresh").mockImplementation(async () => {
            refreshCount += 1;
            // Hold the lock long enough that the second resolve is still waiting.
            await new Promise((resolve) => setTimeout(resolve, 25));

            return {
                accessToken: `fresh-access-${refreshCount}`,
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
        expect(first.token).toBe("fresh-access-1");
        expect(second.token).toBe("fresh-access-1");
    });
});
