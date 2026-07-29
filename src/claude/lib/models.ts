/**
 * Claude models launchable via `claude --model`, plus alias/substring
 * resolution for the `tools claude start --model` flag. Derived from the
 * curated registry (`@genesiscz/utils/ai/models/registry`) — a model appears
 * here only when it carries a `cli` entry there. Grouped by family, newest
 * first within each family; picker order follows this order.
 */

import { byProvider, type ModelFamily } from "@genesiscz/utils/ai/models/registry";

export type ClaudeModelFamily = ModelFamily;

export interface ClaudeModel {
    id: string;
    family: ClaudeModelFamily;
    label: string;
    /** Model supports the `[1m]` 1M-context variant suffix in Claude Code. */
    supports1m?: boolean;
}

const FAMILY_ORDER: ClaudeModelFamily[] = ["fable", "opus", "sonnet", "haiku"];

export const CLAUDE_MODELS: ClaudeModel[] = FAMILY_ORDER.flatMap((family) =>
    byProvider("anthropic")
        .filter((model) => model.family === family && model.flags?.cli)
        .map((model) => ({
            id: model.flags?.cli?.id ?? model.id,
            family,
            label: model.flags?.cli?.label ?? model.displayName,
            supports1m: model.flags?.supports1m,
        }))
);

export interface LaunchableModel {
    /** Exact string passed to `claude --model`, e.g. `claude-opus-4-8[1m]`. */
    id: string;
    label: string;
    family: ClaudeModelFamily;
}

export function listLaunchableModels(): LaunchableModel[] {
    const result: LaunchableModel[] = [];

    for (const model of CLAUDE_MODELS) {
        result.push({ id: model.id, label: model.label, family: model.family });

        if (model.supports1m) {
            result.push({ id: `${model.id}[1m]`, label: `${model.label} — 1M context`, family: model.family });
        }
    }

    return result;
}

export type ModelResolution =
    | { kind: "exact"; model: LaunchableModel }
    | { kind: "ambiguous"; candidates: LaunchableModel[] }
    | { kind: "none" };

/** Lowercase, dots → dashes, brackets stripped, so "4.8 1m" matches "claude-opus-4-8[1m]". */
function normalize(text: string): string {
    return text.toLowerCase().replace(/\./g, "-").replace(/[[\]]/g, "");
}

/**
 * Resolve a `--model` spec: exact id, alias (fable/opus/sonnet/haiku), or
 * whitespace-separated substring tokens that must all match (filter-picker).
 */
export function resolveModelSpec(spec: string): ModelResolution {
    const launchable = listLaunchableModels();
    const trimmed = spec.trim();
    const exact = launchable.find((m) => m.id === trimmed);
    if (exact) {
        return { kind: "exact", model: exact };
    }

    const tokens = normalize(trimmed)
        .split(/[\s,]+/)
        .filter(Boolean);
    if (tokens.length === 0) {
        return { kind: "none" };
    }

    const candidates = launchable.filter((m) => {
        const haystack = normalize(m.id);
        return tokens.every((t) => haystack.includes(t));
    });

    if (candidates.length === 1) {
        return { kind: "exact", model: candidates[0] };
    }

    if (candidates.length > 1) {
        return { kind: "ambiguous", candidates };
    }

    return { kind: "none" };
}

/** Family of a resolved model id (used to pick the binding weekly bucket). */
export function modelFamilyOf(modelId: string): ClaudeModelFamily | undefined {
    const base = modelId.replace(/\[1m\]$/, "");
    return CLAUDE_MODELS.find((m) => m.id === base)?.family;
}
