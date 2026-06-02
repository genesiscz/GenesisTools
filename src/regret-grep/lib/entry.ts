import { fileTypeToken, tokenize } from "./tokenize";
import type { RawCommit, RegretEntry } from "./types";

/**
 * Cap on tokens stored per entry. Keeps the index small and stops one huge
 * commit from dominating the corpus. Subject tokens are always kept; diff
 * tokens fill the remaining budget by frequency.
 */
const MAX_TOKENS_PER_ENTRY = 60;

/**
 * Distill a raw bug-fix commit into the lexical {@link RegretEntry} we score
 * against. Pure and deterministic.
 *
 * Subject tokens are weighted by including them twice (the subject is the
 * highest-signal description of the bug). Diff tokens are deduplicated by
 * frequency and truncated to fit the per-entry budget.
 */
export function distillEntry(commit: RawCommit): RegretEntry {
    const subjectTokens = tokenize(commit.subject);

    const diffFreq = new Map<string, number>();
    for (const line of commit.diffLines) {
        for (const token of tokenize(line)) {
            diffFreq.set(token, (diffFreq.get(token) ?? 0) + 1);
        }
    }

    // Subject tokens counted twice for emphasis.
    const tokens: string[] = [...subjectTokens, ...subjectTokens];

    const budget = MAX_TOKENS_PER_ENTRY - tokens.length;
    if (budget > 0) {
        const rankedDiff = [...diffFreq.entries()]
            .sort((a, b) => {
                if (b[1] !== a[1]) {
                    return b[1] - a[1];
                }

                return a[0].localeCompare(b[0]);
            })
            .slice(0, budget)
            .map(([token]) => token);
        tokens.push(...rankedDiff);
    }

    const fileTypes = [...new Set(commit.files.map(fileTypeToken))].sort();

    return {
        hash: commit.hash,
        subject: commit.subject,
        date: commit.date,
        timestamp: commit.timestamp,
        fileTypes,
        tokens,
    };
}
