import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../config/schema";
import { CredentialUnavailableError, type ResolvedCredential, resolveCredential } from "./credentials";
import type { CredentialSpec } from "./plugin-types";
import { tryProviderPlugin } from "./registry";

/**
 * Resolve an API key for a provider when the caller has no account in hand.
 *
 * This is the ladder for the older, account-less call sites (AICloudProvider and
 * friends), and it is what replaces the argless `createOpenAI()` calls that let
 * the SDK read the environment where nobody could see it:
 *
 *   1. a configured, enabled account for this provider (its own key, or an
 *      environment variable it explicitly opted into)
 *   2. otherwise the variables the plugin declares — with a warning, because a
 *      key arriving this way is invisible in the config
 *   3. otherwise a `CredentialUnavailableError` naming the command that fixes it
 *
 * Step 2 is the grandfather clause: every environment variable that resolved a
 * key before this phase still resolves one after it. What changed is that the
 * resolution is now logged, attributable, and one `tools ai config account add`
 * away from being explicit.
 *
 * It lives here rather than in `credentials.ts` so that the plugins, which all
 * import `resolveCredential`, are not imported back by it.
 */
export async function resolveProviderApiKey(providerId: string): Promise<ResolvedCredential> {
    // Loaded at call time, not import time: the barrel drags in every plugin
    // (the copilot module, the local runtimes, the subscription resolvers), and
    // this module is imported by AICloudProvider, which many tools load without
    // ever making a cloud call.
    const { registerBuiltInPlugins } = await import("./plugins");
    registerBuiltInPlugins();

    const plugin = tryProviderPlugin(providerId);
    const spec: CredentialSpec = plugin?.credential ?? { fields: ["apiKey"], envKeys: [], required: ["apiKey"] };

    for (const account of await accountsFor(providerId)) {
        try {
            const resolved = await resolveCredential(account, spec);
            logger.debug(
                { provider: providerId, account: account.name, source: resolved.source },
                "resolved provider key from a configured account"
            );
            return resolved;
        } catch (err) {
            logger.debug({ err, provider: providerId, account: account.name }, "account holds no usable key");
        }
    }

    for (const name of spec.envKeys) {
        const value = env.ai.getByEnvKey(name);
        if (value) {
            logger.warn(
                { provider: providerId, envKey: name },
                `using ${name} for ${providerId} with no configured account — run \`tools ai config account add --provider ${providerId}\` to make this explicit`
            );
            return { apiKey: value, source: "env", envKey: name };
        }
    }

    throw new CredentialUnavailableError(
        "<none>",
        providerId,
        spec.envKeys.length > 0
            ? `no account and none of ${spec.envKeys.join(", ")} is set. Add one with: tools ai config account add --provider ${providerId}`
            : `no account configured. Add one with: tools ai config account add --provider ${providerId}`
    );
}

/** The api key alone, for the many call sites that only need that. */
export async function providerApiKey(providerId: string): Promise<string> {
    const resolved = await resolveProviderApiKey(providerId);

    if (!resolved.apiKey) {
        throw new CredentialUnavailableError("<none>", providerId, "resolved credential carries no api key");
    }

    return resolved.apiKey;
}

async function accountsFor(providerId: string): Promise<AccountEntry[]> {
    try {
        const { AiConfigStore } = await import("../config/AiConfigStore");
        const store = await AiConfigStore.load();
        return store.accounts({ provider: providerId, enabled: true });
    } catch (err) {
        // A config still on v3 (or one this build is not allowed to migrate) must
        // not take the environment fallback down with it.
        logger.debug({ err, provider: providerId }, "ai config unavailable; falling back to declared env keys");
        return [];
    }
}
