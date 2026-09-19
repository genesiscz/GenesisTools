import { describe, expect, test } from "bun:test";
import type { EvaluationResponse } from "./service";
import { type ChoiceEntrant, chooseByTournament, splitBalanced, type TournamentRound } from "./tournament";

function candidates(count: number): ChoiceEntrant[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `c${index}`,
        label: `row ${index}`,
    }));
}

function answer(choice: string, probability = 0.9): EvaluationResponse {
    return {
        answers: { verb: { type: "choice", choice, probability, probabilities: { [choice]: probability } } },
    } as unknown as EvaluationResponse;
}

const winnerOf = (response: EvaluationResponse): string | null => {
    const verb = response.answers.verb;
    return verb?.type === "choice" && verb.choice !== "abstain" ? verb.choice : null;
};

describe("candidate tournament", () => {
    test("splitBalanced makes the fewest groups that fit and keeps them even and in order", () => {
        expect(splitBalanced([], 10)).toEqual([]);
        expect(splitBalanced([1, 2, 3], 10)).toEqual([[1, 2, 3]]);

        const groups = splitBalanced(
            Array.from({ length: 500 }, (_, i) => i),
            240
        );
        expect(groups).toHaveLength(3);
        expect(groups.map((group) => group.length)).toEqual([167, 167, 166]);
        expect(groups.flat()).toEqual(Array.from({ length: 500 }, (_, i) => i));
        expect(Math.max(...groups.map((group) => group.length))).toBeLessThanOrEqual(240);
    });

    test("a set that fits is one question, exactly as before", async () => {
        const rounds: TournamentRound<ChoiceEntrant>[] = [];
        const outcome = await chooseByTournament({
            candidates: candidates(12),
            winnerOf,
            ask: async (round) => {
                rounds.push(round);
                return answer("c3");
            },
        });

        expect(outcome.rounds).toBe(1);
        expect(rounds).toHaveLength(1);
        expect(rounds[0].final).toBe(true);
        expect(outcome.candidates).toHaveLength(12);
    });

    test("a set that does not fit is split, and the shard winners meet in a final round", async () => {
        const asked: TournamentRound<ChoiceEntrant>[] = [];
        const outcome = await chooseByTournament({
            candidates: candidates(500),
            budget: 240,
            winnerOf,
            ask: async (round) => {
                asked.push(round);
                if (round.final) {
                    return answer("c200", 0.95);
                }

                return answer(round.candidates[0].id);
            },
        });

        expect(asked.filter((round) => !round.final)).toHaveLength(3);
        const final = asked.find((round) => round.final);
        expect(final?.candidates.map((item) => item.id)).toEqual(["c0", "c167", "c334"]);
        expect(outcome.rounds).toBe(4);
        expect(outcome.candidates.map((item) => item.id)).toEqual(["c0", "c167", "c334"]);
        expect(winnerOf(outcome.response as EvaluationResponse)).toBe("c200");
    });

    test("every shard abstaining is an abstain, and costs no final round", async () => {
        let asked = 0;
        const outcome = await chooseByTournament({
            candidates: candidates(500),
            budget: 240,
            winnerOf,
            ask: async () => {
                asked += 1;
                return answer("abstain", 0.99);
            },
        });

        expect(outcome.response).toBeNull();
        expect(outcome.candidates).toEqual([]);
        expect(asked).toBe(3);
        expect(outcome.rounds).toBe(3);
    });

    test("a lone finalist still has to win a final round that offers abstain", async () => {
        const finals: TournamentRound<ChoiceEntrant>[] = [];
        await chooseByTournament({
            candidates: candidates(500),
            budget: 240,
            winnerOf,
            ask: async (round) => {
                if (round.final) {
                    finals.push(round);
                    return answer("c0");
                }

                return round.candidates[0].id === "c0" ? answer("c0") : answer("abstain");
            },
        });

        expect(finals).toHaveLength(1);
        expect(finals[0].candidates.map((item) => item.id)).toEqual(["c0"]);
    });

    test("more shard winners than one question holds play off again", async () => {
        const depths: number[] = [];
        const outcome = await chooseByTournament({
            candidates: candidates(40),
            budget: 2,
            winnerOf,
            ask: async (round) => {
                depths.push(round.depth);
                return answer(round.candidates[0].id);
            },
        });

        expect(Math.max(...depths)).toBeGreaterThan(1);
        expect(outcome.response).not.toBeNull();
        expect(outcome.candidates.length).toBeLessThanOrEqual(2);
    });
});
