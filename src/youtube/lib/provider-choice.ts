import { modelSelector } from "@ask/providers/ModelSelector";
import type { ProviderChoice } from "@ask/types";

export interface ResolveProviderChoiceOpts {
    provider?: string;
    model?: string;
}

export async function resolveProviderChoice(opts: ResolveProviderChoiceOpts = {}): Promise<ProviderChoice> {
    const selected = await modelSelector.selectModelByName(opts.provider, opts.model);

    if (!selected) {
        throw new Error(
            `Could not resolve provider="${opts.provider ?? "(any)"}" model="${opts.model ?? "(any)"}". ` +
                "Configure ANTHROPIC_API_KEY (or another supported provider env var) or pass --provider/--model explicitly."
        );
    }

    return selected;
}
