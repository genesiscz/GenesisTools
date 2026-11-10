import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import type { AccountResolver } from "./index";

export class HuggingFaceResolver implements AccountResolver {
    readonly providerType: AIProvider = "huggingface";

    async resolve(_accountName: string): Promise<DetectedProvider> {
        throw new Error(
            "HuggingFace is not a chat provider and cannot be resolved as a DetectedProvider. " +
                'Use providerApiKey("huggingface") from @genesiscz/utils/ai/providers/resolve for the HF API key.'
        );
    }
}
