import type { ScoredFile } from "./types";

/** Thousands-separated integer, locale-pinned to keep output deterministic across machines. */
export function withThousands(n: number): string {
    return n.toLocaleString("en-US");
}

export interface RoarInput extends ScoredFile {
    gitAvailable: boolean;
}

export function roar(file: RoarInput): string {
    const deps = file.fanIn === 0 ? "nobody depends on me (yet)" : `${withThousands(file.fanIn)} modules depend on me`;
    const head = `I am ${withThousands(file.lines)} lines old and ${deps}.`;

    if (!file.gitAvailable) {
        return head;
    }

    const days = Math.round(file.ageDays);
    if (days < 1) {
        return `${head} I changed today.`;
    }

    return `${head} I have not changed in ${withThousands(days)} days.`;
}
