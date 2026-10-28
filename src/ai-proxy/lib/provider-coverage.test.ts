import { describe, expect, test } from "bun:test";
import { describeAccountCredential } from "@app/ai-proxy/lib/account-config";
import { providerTitleFor, suggestedModelFor } from "@app/ai-proxy/lib/detect-report";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import { createProvider, isProviderImplemented, providerTypes } from "@app/ai-proxy/lib/providers/registry";
import { isMetered } from "@app/ai-proxy/lib/sessions/accounts";
import { loginAccount } from "@app/ai-proxy/lib/sessions/routing";
import { agentOf } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Adding a provider type used to mean touching six independent switch/if chains, each failing SILENTLY when missed.
 * Since 2026-10-28 a provider is one entry in `PROVIDER_DEFINITIONS` (registry.ts), whose required members the
 * compiler asks for. These tests pin what each member answers, so a definition that compiles but answers wrong (a
 * metered key described as a free seat, a missing env name) still fails here. The catalog and usage dispatch are
 * pinned by behaviour in catalog-probe.test.ts and commands/usage.test.ts.
 */

/** Providers that bill a personal subscription authenticate through OAuth, never an api key. */
const SUBSCRIPTION_TYPES: ReadonlySet<AiProxyProviderType> = new Set([
    "grok-subscription",
    "github-copilot-subscription",
    "anthropic-subscription",
    "openai-subscription",
]);

/**
 * ❗ There is no exemption list here, on purpose.
 *
 * This file used to carry a `KNOWN_GAPS` array documenting nine holes that
 * predated it. All nine are closed, so the escape hatch is gone with them: every
 * dimension below now applies to EVERY provider type, unconditionally. Adding one
 * back means arguing for it in review rather than appending a line.
 */
function accountFor(provider: AiProxyProviderType): AiProxyAccountConfig {
    return {
        name: "coverage",
        provider,
        providerSlug: provider.replace(/-(api-key|subscription)$/, ""),
        enabled: true,
    };
}

describe("every valid provider type is wired end to end", () => {
    test("the sweep is not vacuous, and openrouter is in it", () => {
        expect(providerTypes().length).toBeGreaterThan(6);
        expect(providerTypes()).toContain("openrouter");
    });

    for (const provider of providerTypes()) {
        describe(provider, () => {
            test("is implemented at runtime", () => {
                expect(isProviderImplemented(provider)).toBe(true);
            });

            test("its credential source is described", () => {
                const described = describeAccountCredential(accountFor(provider));

                expect(described.source).not.toBe("unknown");
                // A metered API key must report `billed`, or the startup log tells
                // the user their per-token spend is a free subscription seat.
                expect(described.billed).toBe(!SUBSCRIPTION_TYPES.has(provider));
            });

            test("has a human title rather than the raw slug", () => {
                const account = accountFor(provider);

                expect(providerTitleFor(account)).not.toBe(account.providerSlug);
            });

            test("suggests a model id a client can actually call", () => {
                const suggestion = suggestedModelFor(accountFor(provider));

                expect(suggestion).toBeString();
                expect(suggestion).toStartWith("coverage/");
            });

            test("names its own api-key env variable", () => {
                if (SUBSCRIPTION_TYPES.has(provider)) {
                    return;
                }

                const envName = defaultApiKeyEnvName(accountFor(provider));

                // The xAI name is the FALLBACK of that function, so any non-xai
                // provider still reporting it has no branch of its own.
                if (provider !== "xai-api-key") {
                    expect(envName).not.toBe("XAI_API_KEY");
                    expect(envName).not.toBe("X_AI_API_KEY");
                }

                expect(envName).toMatch(/^[A-Z0-9_]+$/);
            });
        });
    }
});

/** Every provider type, written out here so a type that disappears from the code fails the tables below. */
const PROVIDERS: AiProxyProviderType[] = [
    "grok-subscription",
    "github-copilot-subscription",
    "xai-api-key",
    "openai",
    "openrouter",
    "anthropic-subscription",
    "openai-subscription",
];

/** An account as a config file can hold it: a provider name this build has no implementation for. */
function unknownProviderAccount(): AiProxyAccountConfig {
    return SafeJSON.parse('{"name":"work","provider":"carrier-pigeon","providerSlug":"pigeon","enabled":true}', {
        strict: true,
    });
}

function work(provider: AiProxyProviderType, extra: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return { name: "work", provider, providerSlug: "slug", enabled: true, ...extra };
}

function perProvider<T>(answer: (provider: AiProxyProviderType) => T): Record<string, T> {
    return Object.fromEntries(PROVIDERS.map((provider) => [provider, answer(provider)]));
}

describe("each provider type answers with its own facts", () => {
    test("a detect report titles each account by its vendor, and an unknown provider by its slug", () => {
        expect(perProvider((provider) => providerTitleFor(work(provider)))).toEqual({
            "grok-subscription": "Grok",
            "github-copilot-subscription": "GitHub Copilot",
            "xai-api-key": "xAI API",
            openai: "OpenAI API",
            openrouter: "OpenRouter",
            "anthropic-subscription": "Claude subscription",
            "openai-subscription": "ChatGPT/Codex subscription",
        });
        expect(providerTitleFor(unknownProviderAccount())).toBe("pigeon");
    });

    test("a detect report suggests one callable model per provider, and none for an unknown provider", () => {
        expect(perProvider((provider) => suggestedModelFor(work(provider)))).toEqual({
            "grok-subscription": "work/grok/grok-composer-2.5-fast",
            "github-copilot-subscription": "work/github-copilot/claude-sonnet-4",
            "xai-api-key": "work/slug/grok-4.7",
            openai: "work/slug/gpt-6.1-sol",
            openrouter: "work/slug/anthropic/claude-sonnet-5.5",
            "anthropic-subscription": "work/slug/sonnet",
            "openai-subscription": "work/slug/gpt-6.1-sol",
        });
        expect(suggestedModelFor(unknownProviderAccount())).toBeUndefined();
    });

    test("the credential description names the login, the OAuth file or the key variable", () => {
        const described = [
            work("grok-subscription", { grok: { accountName: "grok-login" } }),
            work("grok-subscription", { grok: { authPath: "/fixtures/grok/auth.json" } }),
            work("github-copilot-subscription", { githubCopilot: { dataDir: "/fixtures/copilot" } }),
            work("anthropic-subscription", { anthropicSub: { accountName: "claude-login" } }),
            work("anthropic-subscription"),
            work("openai-subscription", { openaiSub: { accountName: "codex-login" } }),
            work("openai-subscription"),
            work("xai-api-key", { apiKey: "sk-fixture-key-0123" }),
            work("openai", { apiKeyEnv: "FIXTURE_OPENAI_ENV" }),
            work("openrouter", { apiKey: "   ", apiKeyEnv: "FIXTURE_ROUTER_ENV" }),
            unknownProviderAccount(),
        ].map((account) => describeAccountCredential(account));

        expect(described).toEqual([
            { source: 'ai config account "grok-login" (OAuth)', billed: false },
            { source: "OAuth /fixtures/grok/auth.json", billed: false },
            { source: "OAuth /fixtures/copilot", billed: false },
            { source: 'ai config account "claude-login" (OAuth)', billed: false },
            { source: "OAuth (anthropic subscription)", billed: false },
            { source: 'ai config account "codex-login" (OAuth)', billed: false },
            { source: "OAuth (codex auth.json)", billed: false },
            { source: "config apiKey", billed: true },
            { source: "env FIXTURE_OPENAI_ENV", billed: true },
            { source: "env FIXTURE_ROUTER_ENV", billed: true },
            { source: "unknown", billed: false },
        ]);
    });

    test("a session view files each provider under the agent it serves", () => {
        const agents: Record<string, string> = {
            ...perProvider((provider) => agentOf(provider)),
            "carrier-pigeon": agentOf("carrier-pigeon"),
        };

        expect(agents).toEqual({
            "grok-subscription": "grok",
            "github-copilot-subscription": "other",
            "xai-api-key": "grok",
            openai: "other",
            openrouter: "other",
            "anthropic-subscription": "claude",
            "openai-subscription": "codex",
            "carrier-pigeon": "other",
        });
    });

    test("a session counts every account that is not a subscription seat as metered, an unknown one included", () => {
        const metered: Record<string, boolean> = {
            ...perProvider((provider) => isMetered(work(provider))),
            unknown: isMetered(unknownProviderAccount()),
        };

        expect(metered).toEqual({
            "grok-subscription": false,
            "github-copilot-subscription": false,
            "xai-api-key": true,
            openai: true,
            openrouter: true,
            "anthropic-subscription": false,
            "openai-subscription": false,
            unknown: true,
        });
    });

    test("a session builds the account of a login with its agent's subscription provider", () => {
        expect([
            loginAccount("codex", "alice"),
            loginAccount("claude", "alice"),
            loginAccount("grok", "alice"),
        ]).toEqual([
            {
                name: "login:alice",
                enabled: true,
                provider: "openai-subscription",
                providerSlug: "codex",
                openaiSub: { accountName: "alice" },
            },
            {
                name: "login:alice",
                enabled: true,
                provider: "anthropic-subscription",
                providerSlug: "claude-sub",
                anthropicSub: { accountName: "alice" },
            },
            {
                name: "login:alice",
                enabled: true,
                provider: "grok-subscription",
                providerSlug: "grok",
                grok: { accountName: "alice" },
            },
        ]);
    });

    test("an unknown provider is not implemented and cannot be built", async () => {
        expect(isProviderImplemented("carrier-pigeon")).toBe(false);
        await expect(createProvider(unknownProviderAccount())).rejects.toThrow(
            "Provider not implemented yet: carrier-pigeon"
        );
    });
});
