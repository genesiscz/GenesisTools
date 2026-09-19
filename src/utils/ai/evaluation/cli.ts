import { suggestEnumFlag } from "@genesiscz/utils/cli";
import type { Command } from "commander";
import { loadJevSettings, savedJevSettings } from "./settings";
import {
    DEFAULT_EVALUATION_PROVIDER,
    EVALUATION_PROVIDERS,
    type EvaluationProviderId,
    evaluationProviderSchema,
} from "./types";

/**
 * An explicit `--provider` wins, then the value saved by `tools jev config set provider`, then the
 * built-in default. The flag therefore carries no commander default of its own: one would be
 * indistinguishable from the user typing it, and would silently outrank the saved setting.
 */
export function selectedProvider(program: Command): EvaluationProviderId {
    const flag = program.optsWithGlobals().provider;
    const parsed = evaluationProviderSchema.safeParse(
        flag ?? savedJevSettings().provider ?? DEFAULT_EVALUATION_PROVIDER
    );
    if (!parsed.success) {
        throw new Error(suggestEnumFlag("tools jev", "--provider", [...EVALUATION_PROVIDERS]));
    }

    return parsed.data;
}

export function addProviderOption(program: Command): void {
    program.option("--provider [provider]", `Evaluation provider: ${EVALUATION_PROVIDERS.join(" or ")}`);
    program.hook("preAction", async (_parent, command) => {
        await loadJevSettings();
        selectedProvider(command);
    });
}
