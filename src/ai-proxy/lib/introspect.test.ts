import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIntrospectText } from "@app/ai-proxy/lib/introspect";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";

setupStorageSandbox();

const scratch = mkdtempSync(join(tmpdir(), "gt-introspect-"));

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

const grokAuth = join(scratch, "grok", "auth.json");
const copilotDir = join(scratch, "copilot");

const config: AiProxyConfig = {
    listen: { host: "127.0.0.1", port: 8317 },
    proxyApiKey: "aipx-fixture-0123456789",
    translation: { cursorAgent: "auto", thinking: "cursor" },
    public: { mode: "none", basePath: "/ai" },
    accounts: [
        {
            name: "grok",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
            grok: { authPath: grokAuth },
        },
        {
            name: "copilot",
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            enabled: true,
            githubCopilot: { dataDir: copilotDir },
        },
        { name: "xai", provider: "xai-api-key", providerSlug: "xai", enabled: true },
    ],
};

/** Each account's block of `introspect --section endpoints`, keyed by account name. */
async function accountBlocks(): Promise<Record<string, string>> {
    const text = await buildIntrospectText(config, { section: "endpoints" });
    const blocks = text.split("═══ Account: ").slice(1);

    return Object.fromEntries(blocks.map((block) => [block.slice(0, block.indexOf(" ")), `═══ Account: ${block}`]));
}

const GROK_ENDPOINTS = [
    "Upstream endpoints (subscription):",
    "  GET  /v1/models",
    "  GET  /v1/settings",
    "  GET  /v1/billing",
    "  GET  /v1/user",
    "  POST /v1/responses",
    "  POST /v1/chat/completions",
];

describe("buildIntrospectText per provider type", () => {
    it("shows a Grok account's upstream and auth file, and no tier when the auth file has no login", async () => {
        expect((await accountBlocks()).grok).toBe(
            [
                "═══ Account: grok ═══",
                "Provider:     grok-subscription (slug: grok)",
                "Upstream:     https://cli-chat-proxy.grok.com/v1",
                `Auth:         ${grokAuth}`,
                "",
                ...GROK_ENDPOINTS,
                "",
                "",
            ].join("\n")
        );
    });

    it("shows a Copilot account's upstream, token storage and its own endpoints", async () => {
        expect((await accountBlocks()).copilot).toBe(
            [
                "═══ Account: copilot ═══",
                "Provider:     github-copilot-subscription (slug: github-copilot)",
                "Upstream:     https://api.githubcopilot.com",
                `Auth:         AuthStorage(ai-proxy.github-copilot) — legacy ${join(copilotDir, "github_token")}`,
                "",
                "Upstream endpoints (subscription):",
                "  GET  /models",
                "  POST /chat/completions",
                "  POST /responses",
                "  POST /v1/messages",
                "  GET  /copilot_internal/user",
                "",
                "",
            ].join("\n")
        );
    });

    it("prints no auth lines for an api-key account, and the Grok endpoint list under it", async () => {
        expect((await accountBlocks()).xai).toBe(
            ["═══ Account: xai ═══", "Provider:     xai-api-key (slug: xai)", "", ...GROK_ENDPOINTS, ""].join("\n")
        );
    });
});
