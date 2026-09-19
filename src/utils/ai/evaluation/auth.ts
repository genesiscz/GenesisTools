import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";

export const GATEWAY_KEYS_URL =
    "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";
export const TYPESAFE_KEYS_URL = "https://console.typesafe.ai";

import type { EvaluationProviderId } from "./types";

const apiKeySchema = z.string().trim().min(1);

function credentialsStore() {
    return new Storage("jev", { configFileMode: 0o600 });
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
    await storage.setConfigValue(provider === "vercel" ? "apiKey" : "typesafeApiKey", apiKeySchema.parse(apiKey));
    logger.debug({ file: storage.getConfigPath() }, "Saved Jev gateway credential");
    return storage.getConfigPath();
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
    const saved = config?.[provider === "vercel" ? "apiKey" : "typesafeApiKey"];
    if (saved !== undefined) {
        const parsed = apiKeySchema.safeParse(saved);
        if (parsed.success) {
            return parsed.data;
        }
        logger.warn({ file: storage.getConfigPath(), provider }, "Ignoring invalid saved Jev credential");
    }

    const oidcToken = env.getTrimmed("VERCEL_OIDC_TOKEN");
    if (provider === "vercel" && oidcToken) {
        logger.debug("Jev credential source: VERCEL_OIDC_TOKEN");
        return oidcToken;
    }

    throw new Error(`No ${provider} credential. Run tools jev login --provider ${provider} or set ${variable}.`);
}
