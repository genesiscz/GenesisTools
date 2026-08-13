import { describe, expect, test } from "bun:test";
import { describeAccountCredential } from "@app/ai-proxy/lib/account-config";
import { VALID_PROVIDER_TYPES } from "@app/ai-proxy/lib/clients";
import { providerTitleFor, suggestedModelFor } from "@app/ai-proxy/lib/detect-report";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import { isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";

/**
 * Adding a provider type means touching six independent switch/if chains, and
 * every one of them fails SILENTLY when missed: an unimplemented provider is
 * skipped at runtime, an undescribed credential reports `{source: "unknown",
 * billed: false}` for a metered key, a missing title prints the raw slug, a
 * missing env-name branch names the WRONG variable in every error, a missing
 * catalog branch makes `/v1/models` return nothing for the account, and a missing
 * `fetchLiveUsage` branch makes the provider's `getUsage()` dead code from the CLI.
 *
 * One failing test instead of six silent fallthroughs, permanently.
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

async function sourceOf(path: string): Promise<string> {
    return Bun.file(new URL(path, import.meta.url)).text();
}

describe("every valid provider type is wired end to end", () => {
    test("the sweep is not vacuous, and openrouter is in it", () => {
        expect(VALID_PROVIDER_TYPES.size).toBeGreaterThan(6);
        expect(VALID_PROVIDER_TYPES.has("openrouter")).toBe(true);
    });

    for (const provider of VALID_PROVIDER_TYPES) {
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

            test("has a /v1/models catalog branch", async () => {
                expect(await sourceOf("./catalog.ts")).toInclude(`account.provider === "${provider}"`);
            });

            test("has a fetchLiveUsage branch", async () => {
                expect(await sourceOf("../commands/usage.ts")).toInclude(`account.provider === "${provider}"`);
            });
        });
    }
});
