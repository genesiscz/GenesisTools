import { AIConfig } from "@app/utils/ai/AIConfig";
import { modelSelector } from "@ask/providers/ModelSelector";
import { providerManager } from "@ask/providers/ProviderManager";
import type { ProviderChoice } from "@ask/types";

export interface ResolveProviderChoiceOpts {
    provider?: string;
    model?: string;
    /** Configured task default ("provider" or "provider/model", e.g. youtube
     *  config's `provider.summarize`). Applies only when neither `provider`
     *  nor `model` was passed explicitly — an explicit request must never be
     *  silently mixed with a configured spec. */
    fallbackSpec?: string | null;
}

/** Splits a "provider" / "provider/model" config spec. The split is on the
 *  FIRST slash so model ids that themselves contain slashes survive. */
export function parseProviderSpec(spec: string | null | undefined): { provider?: string; model?: string } {
    if (!spec) {
        return {};
    }

    const idx = spec.indexOf("/");
    if (idx === -1) {
        return { provider: spec };
    }

    return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
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
    let { provider, model } = opts;
    if (!provider && !model) {
        ({ provider, model } = parseProviderSpec(opts.fallbackSpec));
    }

    if (!provider && !model) {
        const fallback = await pickDefaultProviderChoice();

        if (fallback) {
            return fallback;
        }
    } else {
        const providerName = provider ?? (await inferDefaultProviderName());
        const selected = await modelSelector.selectModelByName(providerName, model);

        if (selected) {
            return selected;
        }
    }

    throw new Error(
        `Could not resolve provider="${provider ?? "(any)"}" model="${model ?? "(any)"}". ` +
            "Configure an account in ~/.genesis-tools/ai/config.json or pass --provider/--model explicitly."
    );
}
