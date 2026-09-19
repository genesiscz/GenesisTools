import { suggestEnumFlag } from "@genesiscz/utils/cli";
import type { Command } from "commander";
import { EVALUATION_PROVIDERS, type EvaluationProviderId, evaluationProviderSchema } from "./types";

export function selectedProvider(program: Command): EvaluationProviderId {
    const parsed = evaluationProviderSchema.safeParse(program.optsWithGlobals().provider ?? "vercel");
    if (!parsed.success) {
        throw new Error(suggestEnumFlag("tools jev", "--provider", [...EVALUATION_PROVIDERS]));
    }
    return parsed.data;
}

export function addProviderOption(program: Command): void {
    program.option("--provider [provider]", "Evaluation provider: vercel or typesafe", "vercel");
    program.hook("preAction", (_parent, command) => {
        selectedProvider(command);
    });
}
