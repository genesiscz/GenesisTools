/**
 * Contrastive filter — keep an episode iff judge(reference) >= keepRef AND
 * judge(bare model) <= keepNaive. Only moments where the bare model actually
 * fails carry teaching value (headroom); an episode a bare model already nails
 * teaches nothing. Infra failures are dropped as UNASSESSABLE and counted,
 * never silently treated as headroom (SkillOpt B7).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { pipeline } from "@genesiscz/utils/pipeline";
import { ensureMetaDirs, type FableConfig, STAGE_CONCURRENCY } from "../config";
import type { Runner } from "../runners";
import { type JudgeItem, judgeBatch } from "./judge";
import type { Episode } from "./types";

/** Flush a partial judge batch after this long with no new bare reply. */
const JUDGE_BATCH_IDLE_MS = 5_000;

const TASK_FRAMING =
    "You are the agent in the transcript below, at the moment marked. Decide the " +
    "single best next move — the concrete command(s) you would run or the exact " +
    "message you would send to the user. Be specific to THIS situation.";

export interface FilterOptions {
    keepRef: number;
    keepNaive: number;
    judgeBatchSize: number;
    timeoutMs?: number;
    /** Model calls in flight at once (default STAGE_CONCURRENCY). */
    concurrency?: number;
}

export interface FilterCounts {
    total: number;
    kept: number;
    noHeadroom: number;
    refUnrecoverable: number;
    infraFail: number;
    judgeMissing: number;
}

export async function bareReply(runner: Runner, episode: Episode, timeoutMs = 240_000): Promise<string> {
    const result = await runner.call({
        system: TASK_FRAMING,
        user: episode.contextPrefix,
        maxTokens: 3000,
        timeoutMs,
        label: `bare-${episode.id.slice(-4)}`,
    });
    return result.text;
}

export async function contrastiveFilter(
    episodes: Episode[],
    bareRunner: Runner,
    judgeRunner: Runner,
    options: FilterOptions
): Promise<{ kept: Episode[]; scored: Episode[]; counts: FilterCounts }> {
    const counts: FilterCounts = {
        total: episodes.length,
        kept: 0,
        noHeadroom: 0,
        refUnrecoverable: 0,
        infraFail: 0,
        judgeMissing: 0,
    };

    const naive = new Map<string, string>();
    const infraFailed = new Set<string>();
    const concurrency = options.concurrency ?? STAGE_CONCURRENCY;

    /** Judge a stream of candidates: batches leave for the judge as soon as they fill. */
    const judgeStream = async (items: AsyncIterable<JudgeItem> | JudgeItem[]) => {
        const scores = new Map<string, { soft: number }>();
        await pipeline(items, { scope: "lff-filter" })
            .batch("judge-batch", { size: options.judgeBatchSize, maxWaitMs: JUDGE_BATCH_IDLE_MS })
            .map(
                "judge",
                async (batch) => {
                    for (const [id, v] of await judgeBatch(judgeRunner, batch, options.timeoutMs)) {
                        scores.set(id, { soft: v.soft });
                    }
                },
                { concurrency, onError: (error) => logger.warn({ error }, "judge batch failed") }
            )
            .drain();

        return scores;
    };

    // Bare replies feed the judge as they land — no barrier between the two stages —
    // and reference judging runs alongside the whole thing.
    const naiveCandidates = pipeline(episodes, { scope: "lff-filter" }).map(
        "bare-reply",
        async (ep) => {
            const reply = await bareReply(bareRunner, ep, options.timeoutMs);
            if (!reply.trim()) {
                infraFailed.add(ep.id);
                return undefined;
            }

            naive.set(ep.id, reply);
            return { episode: ep, candidate: reply } satisfies JudgeItem;
        },
        {
            concurrency,
            onError: (error, item) => {
                const ep = item as Episode;
                infraFailed.add(ep.id);
                logger.warn({ id: ep.id, error }, "bare-model call failed (episode unassessable)");
            },
        }
    );

    const [refScores, naiveScores] = await Promise.all([
        judgeStream(episodes.map((ep) => ({ episode: ep, candidate: ep.referenceAction }))),
        judgeStream(naiveCandidates),
    ]);

    const kept: Episode[] = [];
    // Every episode that got both scores, kept or not — their scores must persist or
    // a re-run re-judges them from scratch.
    const scored: Episode[] = [];
    for (const ep of episodes) {
        if (infraFailed.has(ep.id)) {
            counts.infraFail++;
            continue;
        }

        const ref = refScores.get(ep.id);
        const nav = naiveScores.get(ep.id);
        if (!ref || !nav) {
            counts.judgeMissing++; // can't assess — drop, don't guess
            continue;
        }

        ep.referenceScore = ref.soft;
        ep.naiveScore = nav.soft;
        ep.naiveReply = naive.get(ep.id);
        scored.push(ep);

        if (ref.soft < options.keepRef) {
            counts.refUnrecoverable++;
        } else if (nav.soft > options.keepNaive) {
            counts.noHeadroom++;
        } else {
            kept.push(ep);
        }
    }

    counts.kept = kept.length;
    out.log.info(
        `filter: kept ${counts.kept}/${counts.total} | dropped: no-headroom ${counts.noHeadroom}, ` +
            `ref-unrecoverable ${counts.refUnrecoverable}, infra-fail ${counts.infraFail}, judge-missing ${counts.judgeMissing}`
    );
    return { kept, scored, counts };
}

/** Rebuild the filtered set from the FULL kept list (incremental runs accumulate, never clobber). */
export function persistFiltered(config: FableConfig, slug: string, kept: Episode[]): string {
    const paths = ensureMetaDirs(config);
    const path = join(paths.episodesDir, `episodes.${slug}.filtered.jsonl`);
    const byId = new Map<string, Episode>();

    if (existsSync(path)) {
        for (const line of readFileSync(path, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const ep: Episode = SafeJSON.parse(line, { strict: true });
                byId.set(ep.id, ep);
            } catch (err) {
                logger.debug({ error: err }, "bad filtered episode line skipped");
            }
        }
    }

    for (const ep of kept) {
        byId.set(ep.id, ep);
    }

    writeFileSync(path, `${[...byId.values()].map((ep) => SafeJSON.stringify(ep, { strict: true })).join("\n")}\n`);
    return path;
}

/**
 * Write the scores back onto the RAW episodes.
 *
 * Without this only the kept episodes carry a score, so every dropped-but-judged
 * episode looks unassessed forever and the next run pays to judge it again: after
 * a run that judged 446 episodes and kept 148, 292 still counted as unfiltered.
 */
export function persistScores(config: FableConfig, slug: string, scored: Episode[]): number {
    const paths = ensureMetaDirs(config);
    const path = join(paths.episodesDir, `episodes.${slug}.raw.jsonl`);
    if (!existsSync(path)) {
        return 0;
    }

    const scoresById = new Map(scored.map((ep) => [ep.id, ep]));
    let updated = 0;
    const lines: string[] = [];

    for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const ep: Episode = SafeJSON.parse(line, { strict: true });
            const fresh = scoresById.get(ep.id);
            if (fresh) {
                ep.referenceScore = fresh.referenceScore;
                ep.naiveScore = fresh.naiveScore;
                ep.naiveReply = fresh.naiveReply;
                updated++;
            }

            lines.push(SafeJSON.stringify(ep, { strict: true }));
        } catch (err) {
            logger.debug({ error: err }, "bad raw episode line skipped while writing scores back");
        }
    }

    writeFileSync(path, `${lines.join("\n")}\n`);
    return updated;
}

export function appendFilterCounts(config: FableConfig, slug: string, runId: string, counts: FilterCounts): void {
    const paths = ensureMetaDirs(config);
    appendFileSync(
        join(paths.metaDir, "filter-runs.jsonl"),
        `${SafeJSON.stringify({ runId, slug, at: new Date().toISOString(), ...counts }, { strict: true })}\n`
    );
}
