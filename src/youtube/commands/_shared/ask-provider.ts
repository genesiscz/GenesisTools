import { modelSelector } from "@ask/providers/ModelSelector";
import type { ProviderChoice } from "@ask/types";
import { isInteractive } from "@app/utils/cli/executor";

export async function loadAskProviderChoice(): Promise<ProviderChoice> {
    const selected = isInteractive()
        ? await modelSelector.selectModel()
        : await modelSelector.selectModelByName();

    if (!selected) {
        throw new Error("Unable to select an AI provider/model for YouTube Q&A. Configure one provider or run interactively.");
    }

    return selected;
}
