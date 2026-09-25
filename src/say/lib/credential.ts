import { resolveProviderApiKey } from "@genesiscz/utils/ai/providers/resolve";
import { logger } from "@genesiscz/utils/logger";
import type { SayProvider } from "@genesiscz/utils/macos/SayConfigManager";

export type SayCredentialCheck =
    | { kind: "ok" }
    | { kind: "fallback"; reason: string; line: string }
    | { kind: "fail"; reason: string; line: string };

/**
 * Whether a cloud provider has a key to speak with, and what to do when it has none.
 *
 * The key comes from the same ladder the speech engines use (`providerApiKey`,
 * src/utils/ai/providers/resolve.ts): the provider's enabled accounts first, then
 * the variables it declares. This used to read the environment alone, so a
 * `tools say` started by Genesis.app or launchd (no shell exports) fell back to
 * macOS even when an account held the key.
 *
 * `reason` is the ladder's own error, which names the command that fixes it.
 */
export async function checkSayCredential(args: {
    provider: SayProvider;
    fallback: boolean;
}): Promise<SayCredentialCheck> {
    const { provider, fallback } = args;

    if (provider === "macos") {
        return { kind: "ok" };
    }

    try {
        await resolveProviderApiKey(provider);
        return { kind: "ok" };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.debug({ err, provider, fallback }, "[say] provider has no usable key");

        if (!fallback) {
            return { kind: "fail", reason, line: `[say] ${provider} has no usable key. ${reason}` };
        }

        return {
            kind: "fallback",
            reason,
            line: `[say] ${provider} has no usable key, falling back to macos. ${reason}`,
        };
    }
}
