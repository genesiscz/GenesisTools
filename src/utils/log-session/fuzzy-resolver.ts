import { fuzzyFind } from "@app/utils/string";

export interface FuzzyResolveOptions {
    toolHint?: string;
    startHint?: string;
}

export function fuzzyResolveSession(query: string, candidates: string[], opts?: FuzzyResolveOptions): string {
    if (candidates.includes(query)) {
        return query;
    }

    const match = fuzzyFind(query, candidates);
    if (match) {
        return match;
    }

    const available = candidates.length > 0 ? candidates.join(", ") : "(none)";
    const toolHint = opts?.toolHint ?? "tools";
    const startHint = opts?.startHint ?? `${toolHint} run --session <name>`;

    throw new Error(`Session "${query}" not found. Available: ${available}\nTip: ${startHint}`);
}
