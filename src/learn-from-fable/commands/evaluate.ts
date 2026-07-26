import { out } from "@genesiscz/utils/logger";
import { type FableConfig, requireStageModel } from "../lib/config";
import { runStage } from "../lib/manifest";
import type { ReasoningEffort } from "../lib/runners";
import { createRunner } from "../lib/runners";
import { persistEvalRun, runAbEval } from "../lib/stages/evaluate";
import { loadEpisodes } from "../lib/stages/mine";

export interface EvalCommandOptions {
    /** Reasoning effort for every model call this stage makes. */
    effort?: ReasoningEffort;
    slug?: string;
    model?: string;
    judgeModel?: string;
    limit?: number;
    judgeBatch: number;
    /** Only use contrast-filtered episodes (referenceScore present). */
    filteredOnly?: boolean;
    json?: boolean;
}

export async function evalCommand(config: FableConfig, options: EvalCommandOptions): Promise<void> {
    const evalModel = requireStageModel(config, "eval", options.model);
    const judgeModel = requireStageModel(config, "judge", options.judgeModel);

    let episodes = loadEpisodes(config, options.slug);
    if (options.filteredOnly) {
        episodes = episodes.filter((ep) => ep.referenceScore !== undefined);
    }

    if (options.limit) {
        episodes = episodes.slice(0, options.limit);
    }

    if (!episodes.length) {
        out.log.info("No episodes to evaluate — run mine (and optionally filter) first.");
        return;
    }

    const evalRunner = createRunner({ model: evalModel, effort: options.effort });
    const judgeRunner = createRunner({ model: judgeModel, effort: options.effort });

    await runStage(
        config,
        {
            stage: "eval",
            model: [evalRunner.id, judgeRunner.id],
            params: { judgeBatch: options.judgeBatch, filteredOnly: options.filteredOnly ?? false },
            inputs: { episodes: episodes.length, slug: options.slug ?? "all" },
        },
        async ({ runId, setOutputs }) => {
            const result = await runAbEval(config, episodes, evalRunner, judgeRunner, {
                judgeBatchSize: options.judgeBatch,
            });
            persistEvalRun(config, runId, { eval: evalRunner.id, judge: judgeRunner.id }, result);
            setOutputs({
                requested: result.requested,
                bare: result.bare,
                withSkill: result.withSkill,
                warnings: result.warnings,
            });

            if (options.json) {
                out.result({ runId, ...result });
            }
        }
    );
}
