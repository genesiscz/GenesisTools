import { chooseProviderModel, parseProviderSpec } from "@genesiscz/utils/ai/core/choose";
import { toProviderChoice } from "@genesiscz/utils/ask/providers/detected";
import type { ProviderChoice } from "@genesiscz/utils/ask/types";

export interface ResolveProviderChoiceOpts {
    provider?: string;
    model?: string;
    /** Configured task default ("provider" or "provider/model", e.g. youtube
     *  config's `provider.summarize`). Applies only when neither `provider`
     *  nor `model` was passed explicitly — an explicit request must never be
     *  silently mixed with a configured spec. */
    fallbackSpec?: string | null;
    /** Let a TTY pick when nothing is configured. Off by default: the server
     *  and the pipeline call this and must never block on a prompt. */
    interactive?: boolean;
}

export { parseProviderSpec };

/**
 * youtube's name for `chooseProviderModel`, projected back to the
 * `{provider, model}` pair its pipeline types carry. The explicit-never-mixed
 * rule that used to live here is now the core's, so every tool applies it.
 */
export async function resolveProviderChoice(opts: ResolveProviderChoiceOpts = {}): Promise<ProviderChoice> {
    return toProviderChoice(
        await chooseProviderModel({
            app: "youtube",
            interactive: opts.interactive ?? false,
            ...(opts.provider ? { provider: opts.provider } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.fallbackSpec ? { fallbackSpec: opts.fallbackSpec } : {}),
        })
    );
}
