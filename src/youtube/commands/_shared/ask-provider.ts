import { isInteractive } from "@app/utils/cli/executor";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { modelSelector } from "@ask/providers/ModelSelector";
import type { ProviderChoice } from "@ask/types";

export interface AskProviderOpts {
    provider?: string;
    model?: string;
}

export async function loadAskProviderChoice(opts: AskProviderOpts = {}): Promise<ProviderChoice> {
    if (opts.provider || opts.model) {
        return resolveProviderChoice(opts);
    }

    const selected = isInteractive() ? await modelSelector.selectModel() : await modelSelector.selectModelByName();

    if (!selected) {
        throw new Error("Unable to select an AI provider/model. Pass --provider/--model or run interactively.");
    }

    return selected;
}
