import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import type { ProviderChoice } from "@genesiscz/utils/ask/types";

export interface AskProviderOpts {
    provider?: string;
    model?: string;
}

/**
 * A CLI command's provider choice: explicit flags win, otherwise a TTY picks and
 * a pipe falls through to the configured defaults.
 */
export async function loadAskProviderChoice(opts: AskProviderOpts = {}): Promise<ProviderChoice> {
    return resolveProviderChoice({ ...opts, interactive: true });
}
