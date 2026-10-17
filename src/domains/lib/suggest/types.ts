import type { Candidate } from "@app/domains/lib/types";

export interface SuggestContext {
    /** Seed words, folded to ASCII and stripped of legal forms: ["genesis", "tech"]. */
    words: string[];
    /** The words joined: "genesistech". */
    joined: string;
    /** TLDs to combine labels with. */
    tlds: string[];
    /** Free-text description for the AI suggestor ("Czech software company"). */
    description?: string;
    /** Cap per suggestor. */
    limit: number;
    /** Feedback for a later AI round: names already taken, and names that were free and liked. */
    avoid?: string[];
    liked?: string[];
    /** ModelRef for the AI suggestor (`haiku`, `@account/<id>:<model>`); default: the `domains` app default. */
    model?: string;
}

export interface Suggestor {
    id: string;
    label: string;
    /** Needs the network (or spends money, for `ai`). Offline suggestors run by default. */
    online: boolean;
    /** Runs when the user names no suggestors. */
    defaultOn: boolean;
    suggest(context: SuggestContext): Promise<Candidate[]>;
}

/** Combine labels with TLDs into candidates for one suggestor. */
export function combine({
    labels,
    tlds,
    source,
    reason,
}: {
    labels: string[];
    tlds: string[];
    source: string;
    reason?: (label: string) => string;
}): Candidate[] {
    const out: Candidate[] = [];
    for (const label of labels) {
        for (const tld of tlds) {
            out.push({ domain: `${label}.${tld}`, sources: [source], reason: reason?.(label) });
        }
    }

    return out;
}
