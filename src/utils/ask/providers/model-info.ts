import { type CatalogEntry, inputModalitiesFor } from "@genesiscz/utils/ai/catalog";
import type { ModelInfo } from "../types";

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
    { pattern: /mini/i, category: "mini" },
    { pattern: /haiku/i, category: "haiku" },
    { pattern: /sonnet/i, category: "sonnet" },
    { pattern: /opus/i, category: "opus" },
    { pattern: /^gpt-(?:4o|4-turbo|4\b|5\b)/i, category: "standard" },
    { pattern: /^o[13]-/i, category: "standard" },
];

function inferCategory(modelId: string): string | undefined {
    for (const { pattern, category } of CATEGORY_PATTERNS) {
        if (pattern.test(modelId)) {
            return category;
        }
    }

    return undefined;
}

/** Tasks any chat model performs; naming them in a picker adds length, not information. */
const IMPLIED_BY_CHAT: ReadonlySet<string> = new Set(["summarize", "translate", "classify", "sentiment"]);

/**
 * Flatten a catalog entry into the shape ask's pickers and pricing table read.
 *
 * The two vocabularies differ: the catalog describes a model by TASK
 * (`chat`, `embed`, `transcribe`) plus structured fields, while `ModelInfo`
 * carries free-form FEATURE strings that `tools ask models --caps` filters on.
 * Vision, reasoning and tool-calling all translate from stated catalog fields
 * (`inputModalities`, `thinking`, `flags.tools`); nothing here is inferred from
 * the model id. `function-calling` is the spelling the pricing table colours and
 * `--caps functions` normalises to.
 */
export function toModelInfo(entry: CatalogEntry): ModelInfo {
    const isChat = entry.capabilities.has("chat");
    const capabilities: string[] = [...entry.capabilities].filter(
        (capability) => !isChat || !IMPLIED_BY_CHAT.has(capability)
    );

    if (inputModalitiesFor(entry)?.includes("image")) {
        capabilities.push("vision");
    }

    if (entry.thinking === "reasoning") {
        capabilities.push("reasoning");
    }

    if (entry.flags?.tools) {
        capabilities.push("function-calling");
    }

    return {
        id: entry.id,
        name: entry.displayName,
        contextWindow: entry.contextWindow,
        capabilities,
        provider: entry.provider,
        category: entry.family ?? inferCategory(entry.id),
        pricing: entry.pricing,
    };
}
