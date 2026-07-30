import {
    getEmbedModelsForType,
    getMaxEmbedChars,
    getModelsForTask,
    getTaskPrefix,
} from "@genesiscz/utils/ai/ModelRegistry";
import type { ModelEntry } from "@genesiscz/utils/ai/types";
import { formatTable } from "@genesiscz/utils/table";

/** @deprecated Use ModelEntry from @genesiscz/utils/ai/types */
export type ModelInfo = ModelEntry;

export { getMaxEmbedChars, getTaskPrefix };

/**
 * On-device embedding models. Named for the task it serves because the plain
 * `MODEL_REGISTRY` collided with the LLM catalog's legacy export of that name —
 * two unrelated lists, one identifier, and an import that read as either.
 */
export const EMBED_MODEL_REGISTRY: ModelEntry[] = [...getModelsForTask("embed")];

/**
 * Returns models sorted with best matches for the given type first.
 */
export function getModelsForType(type: "code" | "files" | "mail" | "chat"): ModelEntry[] {
    return [...getEmbedModelsForType(type)];
}

/**
 * Formats the model list as a CLI-friendly table.
 */
export function formatModelTable(models: ModelEntry[]): string {
    const headers = ["Name", "Params", "Dims", "RAM", "Speed", "License", "Best For"];
    const rows = models.map((m) => [
        m.name,
        m.params ?? "",
        String(m.dimensions ?? ""),
        m.ramGB > 0 ? `${m.ramGB}GB` : m.provider === "cloud" ? "cloud" : "built-in",
        m.speed,
        m.license,
        (m.bestFor ?? []).join(", "),
    ]);

    return formatTable(rows, headers, { alignRight: [2, 3] });
}
