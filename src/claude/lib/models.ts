/**
 * Static registry of Claude models launchable via `claude --model`, plus
 * alias/substring resolution for the `tools claude start --model` flag.
 * Ordered newest-first; picker order follows registry order.
 */

export type ClaudeModelFamily = "fable" | "opus" | "sonnet" | "haiku";

export interface ClaudeModel {
    id: string;
    family: ClaudeModelFamily;
    label: string;
    /** Model supports the `[1m]` 1M-context variant suffix in Claude Code. */
    supports1m?: boolean;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
    { id: "claude-fable-5", family: "fable", label: "Fable 5 (1M native)" },
    { id: "claude-opus-4-8", family: "opus", label: "Opus 4.8", supports1m: true },
    { id: "claude-opus-4-7", family: "opus", label: "Opus 4.7", supports1m: true },
    { id: "claude-opus-4-6", family: "opus", label: "Opus 4.6", supports1m: true },
    { id: "claude-opus-4-5", family: "opus", label: "Opus 4.5" },
    { id: "claude-sonnet-5", family: "sonnet", label: "Sonnet 5", supports1m: true },
    { id: "claude-sonnet-4-6", family: "sonnet", label: "Sonnet 4.6", supports1m: true },
    { id: "claude-sonnet-4-5", family: "sonnet", label: "Sonnet 4.5" },
    { id: "claude-haiku-4-5", family: "haiku", label: "Haiku 4.5" },
];

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
