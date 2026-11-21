/**
 * The check before a push writes a fact outside: compare what this side wrote last (the base), what the outside holds
 * now, and what this side holds now. A push writes a fact only when the outside still holds the base, so an edit made
 * outside is never overwritten without a word.
 */
import type { FactChangedOutside, SentFacts, SyncedFact } from "./types";

export interface FactJudgement {
    /** The facts to write. */
    send: SyncedFact[];
    /** The base after the push: the facts written, and the facts already equal on both sides. */
    sent: SentFacts;
    /** The facts that changed outside since the base; the push leaves them. */
    changedOutside: FactChangedOutside[];
}

function same(a: string, b: string): boolean {
    return a.replaceAll("\r\n", "\n").trim() === b.replaceAll("\r\n", "\n").trim();
}

/**
 * Per fact this side would write: equal outside, it is settled; the outside still holds the base, it is written; else
 * it changed outside and stays. With no base (a pairing from before this check), only an empty outside value is
 * written. `force` writes a fact whatever the outside holds. A fact the outside did not report is written.
 */
export function judgeFacts({
    ours,
    theirs,
    base,
    force = [],
}: {
    ours: SentFacts;
    theirs: SentFacts;
    base: SentFacts;
    force?: readonly SyncedFact[];
}): FactJudgement {
    const judgement: FactJudgement = { send: [], sent: {}, changedOutside: [] };

    for (const [fact, here] of Object.entries(ours) as [SyncedFact, string | undefined][]) {
        if (here === undefined) {
            continue;
        }

        const outside = theirs[fact];
        const known = base[fact];

        if (outside !== undefined && same(outside, here)) {
            judgement.sent[fact] = here;
            continue;
        }

        const write =
            force.includes(fact) ||
            outside === undefined ||
            (known !== undefined ? same(outside, known) : outside.trim() === "");

        if (write) {
            judgement.send.push(fact);
            judgement.sent[fact] = here;
        } else {
            judgement.changedOutside.push({ fact, outside, here });
        }
    }

    return judgement;
}
