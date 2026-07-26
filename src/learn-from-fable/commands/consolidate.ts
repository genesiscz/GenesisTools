import { out } from "@genesiscz/utils/logger";
import type { FableConfig } from "../lib/config";
import { runStage } from "../lib/manifest";
import type { ReasoningEffort } from "../lib/runners";
import { createRunner } from "../lib/runners";
import { consolidate, loadUnconsolidated, persistConsolidation } from "../lib/stages/consolidate";

export interface ConsolidateCommandOptions {
    /** Reasoning effort for every model call this stage makes. */
    effort?: ReasoningEffort;
    /** Comma-separated proxy model ids; falls back to config judge+eval models. */
    models?: string;
    rounds: number;
    batchSize: number;
    surviveThreshold: number;
    json?: boolean;
}

export async function consolidateCommand(config: FableConfig, options: ConsolidateCommandOptions): Promise<void> {
    // Deduped: the same model twice is one voter, not two independent ones, and
    // counting it twice would bias every survive-threshold vote toward itself.
    const modelIds = [
        ...new Set(
            options.models
                ? options.models
                      .split(",")
                      .map((m) => m.trim())
                      .filter(Boolean)
                : [config.models?.judge, config.models?.eval].filter((m): m is string => Boolean(m))
        ),
    ];

    if (!modelIds.length) {
        out.log.error("No voter models — pass --models a,b,c or set models.judge/models.eval in the fable config.");
        return;
    }

    const candidates = loadUnconsolidated(config);
    if (!candidates.length) {
        out.log.info("No unconsolidated principles — run mine first.");
        return;
    }

    const runners = modelIds.map((model) => createRunner({ model, effort: options.effort }));

    await runStage(
        config,
        {
            stage: "consolidate",
            model: runners.map((r) => r.id),
            params: {
                rounds: options.rounds,
                batchSize: options.batchSize,
                surviveThreshold: options.surviveThreshold,
            },
            inputs: { candidates: candidates.length },
        },
        async ({ runId, setOutputs }) => {
            const result = await consolidate(runners, candidates, {
                rounds: options.rounds,
                batchSize: options.batchSize,
                surviveThreshold: options.surviveThreshold,
            });
            persistConsolidation(config, runId, result);
            setOutputs({
                input: result.input,
                survivors: result.survivors.length,
                droppedUseless: result.droppedUseless,
                droppedDuplicates: result.droppedDuplicates,
            });

            if (options.json) {
                out.result({ runId, ...result });
            }
        }
    );
}
