import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { isSecureRef, resolveSecret, secrets } from "@genesiscz/utils/security";
import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";

export const GATEWAY_KEYS_URL =
    "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";
export const TYPESAFE_KEYS_URL = "https://console.typesafe.ai";

import type { EvaluationProviderId } from "./types";

const apiKeySchema = z.string().trim().min(1);

/**
 * The jev config file holds a `SecureRef` — `{ type: "secure", path }` — and never the key.
 *
 * It used to hold the key itself, in plaintext, at mode 0600. Mode 0600 keeps other USERS
 * out; it does nothing about anything running as this user, which is every tool, agent and
 * script on the machine. Every other credential in this repo lives in the AES-256-GCM vault
 * behind `SecretStore`, and `scripts/ci/ai-credentials-guard.sh` reported OK on this file
 * only because its rules name five provider factories and the literal `new Storage("ai")`.
 * The config file stays, because a vault path is not sensitive and seeing it is how a user
 * learns where the credential actually lives.
 */
function credentialsStore() {
    return new Storage("jev", { configFileMode: 0o600 });
}

/** The config key that points at a provider's credential. */
function configField(provider: EvaluationProviderId): string {
    return provider === "vercel" ? "apiKey" : "typesafeApiKey";
}

/** Where the vault keeps a provider's key. */
function vaultPath(provider: EvaluationProviderId): string {
    return `jev/${provider}/apiKey`;
}

export async function saveApiKey(apiKey: string): Promise<string> {
    return saveProviderKey({ apiKey, provider: "vercel" });
}

export async function saveProviderKey({
    apiKey,
    provider,
}: {
    apiKey: string;
    provider: EvaluationProviderId;
}): Promise<string> {
    const storage = credentialsStore();
    const store = await secrets();
    const ref = await store.set(vaultPath(provider), apiKeySchema.parse(apiKey));
    await storage.setConfigValue(configField(provider), ref);
    logger.debug({ file: storage.getConfigPath(), path: ref.path }, "Saved Jev gateway credential");

    return storage.getConfigPath();
}

/**
 * The saved credential, whether it is a vault reference or a key written before the vault.
 *
 * Plaintext is still accepted so an existing `~/.genesis-tools/jev/config.json` keeps
 * working, and it is moved into the vault on first use rather than left to linger until the
 * next login. That migration is best-effort on purpose: a machine with no reachable master
 * key would otherwise lose a credential that worked a moment ago, which is a worse outcome
 * than a plaintext key surviving one more run with a warning against its name.
 */
async function readSavedCredential(
    saved: unknown,
    file: string,
    provider: EvaluationProviderId
): Promise<string | undefined> {
    if (!isSecureRef(saved) && typeof saved !== "string") {
        logger.warn({ file, provider }, "Ignoring invalid saved Jev credential");

        return undefined;
    }

    // A vault that cannot be opened (no reachable master key) used to reject straight out of
    // here, so `resolveApiKey` never reached its `VERCEL_OIDC_TOKEN` fallback.
    let resolved: unknown;

    try {
        resolved = await resolveSecret(saved);
    } catch (err) {
        logger.warn({ error: err, file, provider }, "Could not read the saved Jev credential from the vault");

        return undefined;
    }

    const parsed = apiKeySchema.safeParse(resolved);

    if (!parsed.success) {
        logger.warn({ file, provider }, "Ignoring invalid saved Jev credential");

        return undefined;
    }

    if (typeof saved === "string") {
        try {
            await saveProviderKey({ apiKey: parsed.data, provider });
            logger.warn({ file, provider }, "Moved a plaintext Jev credential into the vault");
        } catch (err) {
            logger.warn({ error: err, file, provider }, "Could not move a plaintext Jev credential into the vault");
        }
    }

    return parsed.data;
}

export async function resolveApiKey(provider: EvaluationProviderId = "vercel"): Promise<string> {
    const variable = provider === "vercel" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY";
    const apiKey = env.getTrimmed(variable);
    if (apiKey) {
        logger.debug({ variable }, "Jev credential source: environment");
        return apiKey;
    }

    const storage = credentialsStore();
    logger.debug({ file: storage.getConfigPath() }, "Reading Jev gateway credential");
    const config = await storage.getConfig<Record<string, unknown>>();
    const saved = config?.[configField(provider)];

    if (saved !== undefined) {
        const secret = await readSavedCredential(saved, storage.getConfigPath(), provider);

        if (secret !== undefined) {
            return secret;
        }
    }

    const oidcToken = env.getTrimmed("VERCEL_OIDC_TOKEN");
    if (provider === "vercel" && oidcToken) {
        logger.debug("Jev credential source: VERCEL_OIDC_TOKEN");
        return oidcToken;
    }

    throw new Error(`No ${provider} credential. Run tools jev login --provider ${provider} or set ${variable}.`);
}
