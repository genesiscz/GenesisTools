/**
 * Consolidation tournament — hand ALL unconsolidated principle candidates to
 * several models; each votes useful/useless with % confidence (and may flag
 * duplicates). Survivors of each round advance; rounds are a CLI parameter.
 * Deliberately does NOT rewrite the spec — merging survivors into FABLE-SPEC.md
 * stays judgment work for the session running the skill (avoid
 * over-consolidation by machine).
 */
import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { ensureMetaDirs, type FableConfig, STAGE_CONCURRENCY } from "../config";
import type { Runner } from "../runners";
import type { PrincipleCandidate } from "./types";

const VOTE_SYSTEM = `\
You are reviewing candidate working-style principles mined from an expert \
agent's ("Fable") real sessions, for inclusion in its distilled operating spec. \
For EACH numbered candidate, vote:
- useful: would this principle, followed by a weaker model, measurably improve \
its engineering judgment? Useless = task-specific trivia, restates the obvious, \
too vague to act on, or actively misleading.
- confidence: 0-100 (%).
- duplicate_of: the index of an EARLIER candidate in this list that says \
essentially the same thing (else null).
- note: <=15 words on why.

Output ONLY a strict JSON array, one object per candidate, same order:
[{"index": <int>, "useful": <bool>, "confidence": <0-100>, "duplicate_of": <int|null>, "note": "..."}]`;

const VOTE_SCHEMA = {
    name: "principle_votes",
    schema: {
        type: "array",
        items: {
            type: "object",
            additionalProperties: false,
            required: ["index", "useful", "confidence"],
            properties: {
                index: { type: "integer" },
                useful: { type: "boolean" },
                confidence: { type: "integer" },
                duplicate_of: { type: ["integer", "null"] },
                note: { type: "string" },
            },
        },
    },
};

export interface Vote {
    model: string;
    round: number;
    useful: boolean;
    confidence: number;
    duplicateOf?: number;
    note?: string;
}

export interface ConsolidatedPrinciple extends PrincipleCandidate {
    votes: Vote[];
    survivedRounds: number;
    /** Mean confidence of the final round's useful-votes. */
    finalConfidence: number;
}

export function loadUnconsolidated(config: FableConfig): PrincipleCandidate[] {
    const paths = ensureMetaDirs(config);
    const file = join(paths.principlesDir, "unconsolidated.jsonl");
    const candidates: PrincipleCandidate[] = [];
    if (!existsSync(file)) {
        return candidates;
    }

    for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            candidates.push(SafeJSON.parse(line, { strict: true }));
        } catch (err) {
            logger.debug({ error: err }, "bad unconsolidated line skipped");
        }
    }

    return candidates;
}

interface RawVote {
    index?: unknown;
    useful?: unknown;
    confidence?: unknown;
    duplicate_of?: unknown;
    note?: unknown;
}

async function voteOnce(
    runner: Runner,
    round: number,
    candidates: PrincipleCandidate[],
    batchSize: number,
    timeoutMs: number
): Promise<Map<number, Vote>> {
    const votes = new Map<number, Vote>();
    const starts: number[] = [];
    for (let start = 0; start < candidates.length; start += batchSize) {
        starts.push(start);
    }

    const voteBatch = async (start: number) => {
        const batch = candidates.slice(start, start + batchSize);
        const listing = batch
            .map(
                (p, i) =>
                    `${start + i}. ${p.principle}\n   why: ${p.why} (session ${p.sessionStem.slice(0, 8)}, miner ${p.minedBy})`
            )
            .join("\n");
        try {
            const reply = await runner.call({
                system: VOTE_SYSTEM,
                user: `Candidates:\n${listing}`,
                maxTokens: 200 * batch.length + 500,
                timeoutMs,
                jsonSchema: VOTE_SCHEMA,
                label: `vote-r${round}-${start}`,
            });

            if (!Array.isArray(reply.parsed)) {
                logger.warn(
                    { runner: runner.id, round, start, parseError: reply.parseError },
                    "vote batch unparseable"
                );
                return;
            }

            for (const raw of reply.parsed as RawVote[]) {
                const index = Number(raw.index);
                if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
                    continue;
                }

                votes.set(index, {
                    model: runner.id,
                    round,
                    useful: raw.useful === true,
                    confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 0)),
                    duplicateOf:
                        typeof raw.duplicate_of === "number" && raw.duplicate_of >= 0 ? raw.duplicate_of : undefined,
                    note: raw.note ? String(raw.note).slice(0, 120) : undefined,
                });
            }
        } catch (err) {
            logger.warn({ runner: runner.id, round, start, error: err }, "vote batch failed");
        }
    };

    await concurrentMap({ items: starts, fn: voteBatch, concurrency: STAGE_CONCURRENCY });
    return votes;
}

export interface ConsolidateOptions {
    rounds: number;
    batchSize: number;
    /** Fraction of voters that must vote useful for a candidate to survive a round. */
    surviveThreshold: number;
    timeoutMs?: number;
}

export interface ConsolidateResult {
    input: number;
    survivors: ConsolidatedPrinciple[];
    droppedUseless: number;
    droppedDuplicates: number;
}

export async function consolidate(
    runners: Runner[],
    candidates: PrincipleCandidate[],
    options: ConsolidateOptions
): Promise<ConsolidateResult> {
    const allVotes = new Map<PrincipleCandidate, Vote[]>(candidates.map((c) => [c, []]));
    let alive = [...candidates];
    let droppedUseless = 0;
    let droppedDuplicates = 0;

    for (let round = 1; round <= options.rounds && alive.length; round++) {
        const perModel = await Promise.all(
            runners.map((runner) => voteOnce(runner, round, alive, options.batchSize, options.timeoutMs ?? 300_000))
        );

        const next: PrincipleCandidate[] = [];
        const survivedIdx = new Set<number>();
        for (const [i, candidate] of alive.entries()) {
            const votes = perModel.map((m) => m.get(i)).filter((v): v is Vote => v !== undefined);
            allVotes.get(candidate)?.push(...votes);

            if (!votes.length) {
                next.push(candidate); // unassessed ≠ useless — keep, don't guess
                survivedIdx.add(i);
                continue;
            }

            // A duplicate vote counts only when it points at a principle that is
            // still alive this round: being a duplicate of something the round
            // already dropped leaves nothing for this candidate to duplicate.
            // Gated by the same fraction as usefulness, so one dissenting voter
            // cannot delete a candidate the rest of the panel wanted to keep.
            const duplicateVotes = votes.filter(
                (v) => v.duplicateOf !== undefined && v.duplicateOf < i && survivedIdx.has(v.duplicateOf)
            ).length;
            const usefulFraction = votes.filter((v) => v.useful).length / votes.length;

            if (duplicateVotes / votes.length >= options.surviveThreshold) {
                droppedDuplicates++;
            } else if (usefulFraction >= options.surviveThreshold) {
                next.push(candidate);
                survivedIdx.add(i);
            } else {
                droppedUseless++;
            }
        }

        out.log.info(`round ${round}: ${alive.length} → ${next.length} survivors`);
        alive = next;
    }

    const survivors: ConsolidatedPrinciple[] = alive.map((candidate) => {
        const votes = allVotes.get(candidate) ?? [];
        const lastRound = Math.max(0, ...votes.map((v) => v.round));
        const finalUseful = votes.filter((v) => v.round === lastRound && v.useful);
        return {
            ...candidate,
            votes,
            survivedRounds: lastRound,
            finalConfidence: finalUseful.length
                ? Math.round(finalUseful.reduce((s, v) => s + v.confidence, 0) / finalUseful.length)
                : 0,
        };
    });

    return { input: candidates.length, survivors, droppedUseless, droppedDuplicates };
}

/** Survivors append to consolidated.jsonl; unconsolidated.jsonl is archived (never destroyed). */
export function persistConsolidation(config: FableConfig, runId: string, result: ConsolidateResult): void {
    const paths = ensureMetaDirs(config);
    const consolidated = join(paths.principlesDir, "consolidated.jsonl");
    for (const p of result.survivors) {
        appendFileSync(consolidated, `${SafeJSON.stringify({ ...p, consolidationRunId: runId }, { strict: true })}\n`);
    }

    const source = join(paths.principlesDir, "unconsolidated.jsonl");
    if (existsSync(source)) {
        renameSync(source, join(paths.principlesDir, `unconsolidated.${runId}.voted.jsonl`));
    }

    out.log.success(
        `consolidated: ${result.survivors.length}/${result.input} kept ` +
            `(dropped ${result.droppedUseless} useless, ${result.droppedDuplicates} duplicates) → ${consolidated}`
    );
}
