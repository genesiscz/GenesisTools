import { logger } from "@genesiscz/utils/logger";
import type { EvaluationResponse } from "./service";

const { log } = logger.scoped("jev-tournament");

/** Anything with a stable id can be chosen between; the caller owns what the id means. */
export interface ChoiceEntrant {
    id: string;
    label: string;
}

/** Jev refuses a choice question with more options than this, `abstain` included. */
export const CHOICE_OPTION_LIMIT = 255;

/** Candidates per question. The remaining slots are `abstain` plus headroom. */
export const SHARD_BUDGET = 240;

/**
 * Split into as few groups as possible, each within `budget`, balanced so every question carries a
 * similar load rather than one full group and one near-empty one. Order is preserved, so the same
 * observation always shards the same way and a decision can be replayed from the log.
 */
export function splitBalanced<T>(items: readonly T[], budget: number): T[][] {
    if (budget < 1) {
        throw new Error("Shard budget must be at least 1.");
    }

    if (items.length <= budget) {
        return items.length === 0 ? [] : [[...items]];
    }

    const groups = Math.ceil(items.length / budget);
    const size = Math.ceil(items.length / groups);
    const out: T[][] = [];
    for (let start = 0; start < items.length; start += size) {
        out.push([...items.slice(start, start + size)]);
    }

    return out;
}

export interface TournamentRound<T extends ChoiceEntrant> {
    candidates: T[];
    /** The round whose answer the admission gate will judge. */
    final: boolean;
    /** 0 for the first split, incremented for each play-off round above it. */
    depth: number;
}

export interface TournamentOutcome<T extends ChoiceEntrant> {
    /** The final round's answer, or null when no round found a target. */
    response: EvaluationResponse | null;
    /** The candidate set the final round chose from; the gate's `allowed` list comes from this. */
    candidates: T[];
    /** How many Jev questions this decision cost. */
    rounds: number;
}

export interface TournamentOptions<T extends ChoiceEntrant> {
    candidates: T[];
    ask: (round: TournamentRound<T>) => Promise<EvaluationResponse>;
    /** Reads the chosen candidate id out of a round's answer; "abstain" and unknown ids drop out. */
    winnerOf: (response: EvaluationResponse) => string | null;
    budget?: number;
}

/**
 * One choice when the candidates fit, and a knock-out tournament when they do not: split into
 * groups that fit, ask Jev each group, then ask it again over the winners. Nothing is hidden from
 * the model, which is the point — ranking and truncating would decide the answer here instead of
 * letting Jev decide it.
 *
 * Every round offers `abstain`, so a group with no match contributes no finalist and a lone
 * finalist still has to beat abstaining in the final round. The admission gate judges that final
 * round only, at the usual thresholds.
 *
 * The play-off recurses, so any candidate count terminates: an observation is capped at 2000 rows,
 * which is nine groups at the default budget, so real inputs settle in two rounds.
 */
export async function chooseByTournament<T extends ChoiceEntrant>(
    options: TournamentOptions<T>
): Promise<TournamentOutcome<T>> {
    const budget = options.budget ?? SHARD_BUDGET;
    if (options.candidates.length <= budget) {
        const response = await options.ask({ candidates: options.candidates, final: true, depth: 0 });
        return { response, candidates: options.candidates, rounds: 1 };
    }

    return playOff(options, budget, options.candidates, 0, 0);
}

async function playOff<T extends ChoiceEntrant>(
    options: TournamentOptions<T>,
    budget: number,
    entrants: T[],
    depth: number,
    spent: number
): Promise<TournamentOutcome<T>> {
    const groups = splitBalanced(entrants, budget);
    log.info({ depth, entrants: entrants.length, groups: groups.length, budget }, "candidate tournament round");
    const answers = await Promise.all(groups.map((candidates) => options.ask({ candidates, final: false, depth })));
    const rounds = spent + groups.length;
    const byId = new Map(entrants.map((candidate) => [candidate.id, candidate]));
    const finalists: T[] = [];
    for (const answer of answers) {
        const winner = options.winnerOf(answer);
        const candidate = winner === null ? undefined : byId.get(winner);
        if (candidate && !finalists.some((item) => item.id === candidate.id)) {
            finalists.push(candidate);
        }
    }

    log.info({ depth, finalists: finalists.map((item) => item.label.slice(0, 60)) }, "tournament finalists");
    if (finalists.length === 0) {
        return { response: null, candidates: [], rounds };
    }

    if (finalists.length > budget) {
        return playOff(options, budget, finalists, depth + 1, rounds);
    }

    const response = await options.ask({ candidates: finalists, final: true, depth: depth + 1 });
    return { response, candidates: finalists, rounds: rounds + 1 };
}
