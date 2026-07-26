import { out } from "@genesiscz/utils/logger";
import { type FableConfig, requireStageModel } from "../lib/config";
import { runStage } from "../lib/manifest";
import type { ReasoningEffort } from "../lib/runners";
import { createRunner } from "../lib/runners";
import { appendFilterCounts, contrastiveFilter, persistFiltered, persistScores } from "../lib/stages/filter";
import { loadEpisodes, modelSlug } from "../lib/stages/mine";
import type { Episode } from "../lib/stages/types";

export interface FilterOptions {
    /** Reasoning effort for every model call this stage makes. */
    effort?: ReasoningEffort;
    /** Episode source model slug (default: all raw episode files). */
    slug?: string;
    filterBareModel?: string;
    filterReferenceModel?: string;
    keepRef: number;
    keepNaive: number;
    judgeBatch: number;
    limit?: number;
    json?: boolean;
}

export async function filterCommand(config: FableConfig, options: FilterOptions): Promise<void> {
    const bareModel = requireStageModel(config, "filterBare", options.filterBareModel);
    const judgeModel = requireStageModel(config, "judge", options.filterReferenceModel);

    const all = loadEpisodes(config, options.slug);
    const unfiltered = all.filter((ep) => ep.referenceScore === undefined);
    const episodes = options.limit ? unfiltered.slice(0, options.limit) : unfiltered;

    if (!episodes.length) {
        out.log.info(`No unfiltered episodes${options.slug ? ` for slug ${options.slug}` : ""}.`);
        return;
    }

    const bareRunner = createRunner({ model: bareModel, effort: options.effort });
    const judgeRunner = createRunner({ model: judgeModel, effort: options.effort });

    await runStage(
        config,
        {
            stage: "filter",
            model: [bareRunner.id, judgeRunner.id],
            params: { keepRef: options.keepRef, keepNaive: options.keepNaive, judgeBatch: options.judgeBatch },
            inputs: { episodes: episodes.length, slug: options.slug ?? "all" },
        },
        async ({ runId, setOutputs }) => {
            const { kept, scored, counts } = await contrastiveFilter(episodes, bareRunner, judgeRunner, {
                keepRef: options.keepRef,
                keepNaive: options.keepNaive,
                judgeBatchSize: options.judgeBatch,
            });

            // "kept 0/94, infra-fail 94" is not a filter result, it is an outage —
            // the proxy was down and every call was refused in 6s. Reporting it as
            // an ok stage run is a false green (it happened 2026-07-25).
            if (counts.infraFail === counts.total && counts.total > 0) {
                throw new Error(
                    `every episode failed on infrastructure (${counts.total}/${counts.total}) — check the ai-proxy is up: tools ai-proxy up`
                );
            }

            // group kept episodes per source-model slug so per-model files stay separate
            const bySlug = new Map<string, typeof kept>();
            for (const ep of kept) {
                const slug = modelSlug(ep.minedBy);
                bySlug.set(slug, [...(bySlug.get(slug) ?? []), ep]);
            }

            const files: string[] = [];
            for (const [slug, eps] of bySlug) {
                files.push(persistFiltered(config, slug, eps));
                appendFilterCounts(config, slug, runId, counts);
            }

            // Scores go back onto every judged episode, kept or dropped, so the next
            // run only pays for what is genuinely unassessed.
            const scoredBySlug = new Map<string, Episode[]>();
            for (const ep of scored) {
                const slug = modelSlug(ep.minedBy);
                scoredBySlug.set(slug, [...(scoredBySlug.get(slug) ?? []), ep]);
            }

            let scoresWritten = 0;
            for (const [slug, eps] of scoredBySlug) {
                scoresWritten += persistScores(config, slug, eps);
            }

            setOutputs({ counts, files, scoresWritten });
            if (options.json) {
                out.result({ runId, counts, files, scoresWritten });
            }
        }
    );
}
