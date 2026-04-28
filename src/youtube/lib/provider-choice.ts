import { AIConfig } from "@app/utils/ai/AIConfig";
import { modelSelector } from "@ask/providers/ModelSelector";
import { providerManager } from "@ask/providers/ProviderManager";
import type { ProviderChoice } from "@ask/types";

export interface ResolveProviderChoiceOpts {
    provider?: string;
    model?: string;
}

async function inferDefaultProviderName(): Promise<string | undefined> {
    try {
        const config = await AIConfig.load();
        const account = config.getDefaultAccount("ask");

        if (!account) {
            return undefined;
        }

        return account.provider.replace(/-sub$/, "");
    } catch {
        return undefined;
    }
}

async function pickDefaultProviderChoice(): Promise<ProviderChoice | null> {
    const providers = await providerManager.detectProviders();

    if (providers.length === 0) {
        return null;
    }

    const defaultName = await inferDefaultProviderName();
    const provider = (defaultName && providers.find((p) => p.name === defaultName)) || providers[0];
    const model = provider.models[0];

    if (!model) {
        return null;
    }

    return { provider, model };
}

export async function resolveProviderChoice(opts: ResolveProviderChoiceOpts = {}): Promise<ProviderChoice> {
    if (!opts.provider && !opts.model) {
        const fallback = await pickDefaultProviderChoice();

        if (fallback) {
            return fallback;
        }
    } else {
        const providerName = opts.provider ?? (await inferDefaultProviderName());
        const selected = await modelSelector.selectModelByName(providerName, opts.model);

        if (selected) {
            return selected;
        }
    }

    throw new Error(
        `Could not resolve provider="${opts.provider ?? "(any)"}" model="${opts.model ?? "(any)"}". ` +
            "Configure an account in ~/.genesis-tools/ai/config.json or pass --provider/--model explicitly."
    );
}
