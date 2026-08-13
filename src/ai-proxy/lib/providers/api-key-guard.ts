import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/** Where an api-key account's credential came from — logged, never the key itself. */
export type ApiKeySource = "config" | "configEnv" | "defaultEnv";

export interface ResolvedApiKey {
    key: string;
    source: ApiKeySource;
}

/**
 * The single precedence rule for every api-key account: a key stored on the
 * account, then the env var the account names, then the provider's default.
 *
 * It lives beside the guard because the guard's whole decision is a function of
 * the `source` this returns — a provider that resolved a key its own way could
 * hand the guard a `source` that does not describe where the key actually came
 * from, and the refusal would then be wrong in either direction. Only the last
 * step differs per provider, so that one is injected.
 */
export function resolveAccountApiKey(input: {
    account: AiProxyAccountConfig;
    defaultEnvKey: () => string | undefined;
    /**
     * Every env var name `defaultEnvKey` would ever read (aliases included,
     * e.g. xAI's `XAI_API_KEY` / `X_AI_API_KEY`). Distinguishes "this account
     * never customized its variable name" from "this account was pointed at a
     * genuinely different one" — see the comment below.
     */
    knownEnvNames: readonly string[];
}): ResolvedApiKey | undefined {
    const configured = input.account.apiKey?.trim();

    if (configured) {
        return { key: configured, source: "config" };
    }

    if (input.account.apiKeyEnv) {
        const named = env.getTrimmed(input.account.apiKeyEnv as never);

        if (named) {
            return { key: named, source: "configEnv" };
        }

        // A CUSTOM name — one that is not even an alias of the provider's own
        // default — is a deliberate choice to use a different credential slot,
        // usually to run two accounts on two different keys. Falling through to
        // the provider's default here would silently bill the OTHER account's
        // key instead of reporting "not found" for this one. The fallback stays
        // available only when the account's name IS one the provider itself
        // would already check (`xai-api-key.test.ts` "falls back to standard
        // xAI aliases" — XAI_API_KEY and X_AI_API_KEY name the same credential).
        if (!input.knownEnvNames.includes(input.account.apiKeyEnv)) {
            return undefined;
        }
    }

    const fallback = input.defaultEnvKey();

    return fallback ? { key: fallback, source: "defaultEnv" } : undefined;
}

/**
 * Guard for the one credential path that costs metered money: an api-key
 * account picking a key out of the ambient environment.
 *
 * A key stored on the account (`apiKey`) is a deliberate act, so it is always
 * allowed. A key that merely happens to sit in the shell env is not: it is how
 * a rotated or borrowed `XAI_API_KEY` gets spent by surprise, and it is exactly
 * what the proxy is supposed to make impossible. Using one now requires
 * `allowEnvApiKey` on the account, and even then it is logged loudly.
 */
export function assertApiKeySourceAllowed(input: {
    account: AiProxyAccountConfig;
    source: ApiKeySource;
    envName: string;
}): void {
    if (input.source === "config") {
        return;
    }

    if (input.account.allowEnvApiKey) {
        logger.warn(
            { account: input.account.name, provider: input.account.provider, apiKeyEnv: input.envName },
            "ai-proxy: account is opted in to spending the ambient environment API key"
        );

        return;
    }

    throw new Error(
        `Refusing to spend the ambient ${input.envName} for billed account "${input.account.name}": ` +
            "an environment key is never used implicitly. Store the key on the account with " +
            `\`tools ai-proxy accounts set-key ${input.account.name}\`, or opt in explicitly with ` +
            `\`tools ai-proxy accounts allow-env ${input.account.name}\`.`
    );
}
