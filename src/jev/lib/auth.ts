import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";

export const GATEWAY_KEYS_URL =
    "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";
const credentialsSchema = z.object({ apiKey: z.string().trim().min(1) });

function credentialsStore() {
    return new Storage("jev", { configFileMode: 0o600 });
}

export async function saveApiKey(apiKey: string): Promise<string> {
    const credentials = credentialsSchema.parse({ apiKey });
    const storage = credentialsStore();
    await storage.setConfig(credentials);
    logger.debug({ file: storage.getConfigPath() }, "Saved Jev gateway credential");
    return storage.getConfigPath();
}

export async function resolveApiKey(): Promise<string> {
    const apiKey = env.getTrimmed("AI_GATEWAY_API_KEY");
    if (apiKey) {
        logger.debug("Jev credential source: AI_GATEWAY_API_KEY");
        return apiKey;
    }

    const storage = credentialsStore();
    logger.debug({ file: storage.getConfigPath() }, "Reading Jev gateway credential");
    const config = await storage.getConfig<Record<string, unknown>>();
    if (config) {
        logger.debug("Jev credential source: saved API key");
        return credentialsSchema.parse(config).apiKey;
    }

    const oidcToken = env.getTrimmed("VERCEL_OIDC_TOKEN");
    if (oidcToken) {
        logger.debug("Jev credential source: VERCEL_OIDC_TOKEN");
        return oidcToken;
    }

    throw new Error("No AI Gateway credential. Run `tools jev login` or set AI_GATEWAY_API_KEY.");
}
