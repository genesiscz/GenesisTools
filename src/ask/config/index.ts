import { Storage } from "@app/utils/storage/storage";
import type { AskConfig } from "@ask/types/config";

const storage = new Storage("ask");

const DEFAULT_CONFIG: AskConfig = {
    envTokens: { enabled: true },
};

export async function loadAskConfig(): Promise<AskConfig> {
    const saved = await storage.getConfig<Partial<AskConfig>>();

    if (!saved) {
        return { ...DEFAULT_CONFIG, envTokens: { ...DEFAULT_CONFIG.envTokens! } };
    }

    return {
        ...DEFAULT_CONFIG,
        ...saved,
        envTokens: {
            enabled: saved.envTokens?.enabled ?? DEFAULT_CONFIG.envTokens!.enabled,
            disabledProviders: saved.envTokens?.disabledProviders,
        },
    };
}

export async function saveAskConfig(config: AskConfig): Promise<void> {
    await storage.setConfig(config);
}
