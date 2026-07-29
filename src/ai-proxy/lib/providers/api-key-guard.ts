import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@genesiscz/utils/logger";

/** Where an api-key account's credential came from — logged, never the key itself. */
export type ApiKeySource = "config" | "configEnv" | "defaultEnv";

export interface ResolvedApiKey {
    key: string;
    source: ApiKeySource;
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
