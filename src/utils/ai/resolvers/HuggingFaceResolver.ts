import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";

export class HuggingFaceResolver implements AccountResolver {
    readonly providerType: AIProvider = "huggingface";

    async resolve(_accountName: string): Promise<DetectedProvider> {
        throw new Error(
            "HuggingFace is not a chat provider and cannot be resolved as a DetectedProvider. " +
                "Use AIConfig.getHfToken() to access the HF API key directly.",
        );
    }
}
