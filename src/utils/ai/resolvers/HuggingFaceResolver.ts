import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";

export class HuggingFaceResolver implements AccountResolver {
    readonly providerType: AIProvider = "huggingface";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(accountName);

        if (!entry?.tokens.apiKey) {
            throw new Error(`No API key found for HuggingFace account "${accountName}".`);
        }

        // HF doesn't use the ai-sdk provider pattern — return a minimal
        // DetectedProvider so the account handle works uniformly.
        // Callers that need the raw API key use config.getHfToken() directly.
        return {
            name: "huggingface",
            type: "huggingface" as string,
            key: `${entry.tokens.apiKey.slice(0, 8)}...`,
            provider: null as never, // no ai-sdk provider for HF
            models: [],
            config: { name: "huggingface", type: "huggingface", envKey: "HF_TOKEN", description: "HuggingFace Inference API", priority: 99 },
        };
    }
}
