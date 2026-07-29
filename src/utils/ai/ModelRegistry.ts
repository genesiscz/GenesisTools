import type { AITask } from "@genesiscz/utils/config/ai.types";
import {
    byTask,
    byTaskAndProvider,
    embeddingProviderTypes,
    embedModelsForType,
    findDescriptor,
    maxEmbedChars,
    taskPrefix,
} from "./local/descriptors";
import type { ModelEntry } from "./types";

/**
 * @deprecated The catalogue moved to `./local/descriptors`. These wrappers keep
 * the old names alive for existing callers; new code imports the descriptor
 * functions directly. `getModelsForTask` in particular is ambiguous — the one
 * here takes an `AITask` and returns entries, the one in `./ModelManager` takes
 * a task+provider pair and returns picker choices.
 */

export function getModelsForTask(task: AITask): ReadonlyArray<ModelEntry> {
    return byTask(task);
}

export function getModelsByProvider(task: AITask, provider: string): ReadonlyArray<ModelEntry> {
    return byTaskAndProvider(task, provider);
}

export function getEmbeddingProviderTypes(): ReadonlySet<ModelEntry["provider"]> {
    return embeddingProviderTypes();
}

export function findModel(id: string): ModelEntry | undefined {
    return findDescriptor(id);
}

export function getMaxEmbedChars(modelId: string): number {
    return maxEmbedChars(modelId);
}

export function getTaskPrefix(modelId: string): { document: string; query: string } | null {
    return taskPrefix(modelId);
}

export function getEmbedModelsForType(type: "code" | "files" | "mail" | "chat"): ReadonlyArray<ModelEntry> {
    return embedModelsForType(type);
}
