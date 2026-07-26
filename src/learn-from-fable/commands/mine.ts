import { logger, out } from "@genesiscz/utils/logger";
import { pipeline } from "@genesiscz/utils/pipeline";
import { type FableConfig, requireStageModel } from "../lib/config";
import { listCandidates, loadMinedState, unminedCandidates } from "../lib/enumerate";
import { runStage } from "../lib/manifest";
import type { ReasoningEffort } from "../lib/runners";
import { createRunner, type RunnerSpec } from "../lib/runners";
import { minedStemsForModel, mineSession, persistSessionResult } from "../lib/stages/mine";

export interface MineOptions {
    /** Reasoning effort for every model call this stage makes. */
    effort?: ReasoningEffort;
    /** Re-issue an extractor call that outlives this many ms (0 disables). */
    hedgeAfterMs?: number;
    limit: number;
    minSize: number;
    maxWindows: number;
    maxPerSession: number;
    model?: string;
    backend?: RunnerSpec["backend"];
    ccProfile?: string;
    /** Explicit session files (overrides selection). */
    sessions?: string[];
    /** Sessions mined at once; each one still fans its own windows out. */
    sessionConcurrency?: number;
    /** Parse + window census only, no model calls (= the pre-mine stage). */
    dry?: boolean;
    json?: boolean;
}

export async function mineCommand(config: FableConfig, options: MineOptions): Promise<void> {
    let sessionPaths = options.sessions ?? [];
    const backend = options.backend ?? "ai-proxy";
    const model =
        options.dry && !options.model && backend === "ai-proxy"
            ? undefined
            : requireStageModel(config, "mine", options.model);
    const runner = options.dry
        ? undefined
        : createRunner({ backend, model: model ?? "", ccProfile: options.ccProfile, effort: options.effort });

    if (!sessionPaths.length) {
        const candidates = await listCandidates(config, { minSize: options.minSize });
        const legacyMined = loadMinedState(config);
        const modelMined = runner ? minedStemsForModel(config, runner.id) : new Set<string>();
        sessionPaths = unminedCandidates(candidates, legacyMined)
            .filter((c) => !modelMined.has(c.stem))
            .slice(0, options.limit)
            .map((c) => c.path);
    }

    if (!sessionPaths.length) {
        out.log.info("Nothing unmined for this selection.");
        return;
    }

    await runStage(
        config,
        {
            stage: options.dry ? "pre-mine" : "mine",
            model: runner?.id,
            params: {
                maxWindows: options.maxWindows,
                maxPerSession: options.maxPerSession,
                limit: options.limit,
                dry: options.dry ?? false,
            },
            inputs: { sessions: sessionPaths },
        },
        async ({ runId, setOutputs }) => {
            const summaries: unknown[] = [];
            let episodes = 0;
            let principles = 0;
            let failed = 0;
            let done = 0;

            // Sessions are independent and each one only keeps STAGE_CONCURRENCY
            // extractor calls in flight, so mining a few at once stays inside the
            // fan-out the proxy was measured at (20 concurrent grok calls = 15x the
            // serial sum). Persistence runs as a concurrency-1 stage because it is a
            // read-modify-write of shared jsonl files.
            const sessionConcurrency = options.dry ? 1 : Math.max(1, options.sessionConcurrency ?? 3);

            await pipeline(sessionPaths, { scope: "lff-mine-sessions" })
                .map(
                    "mine-session",
                    (path: string) =>
                        mineSession(config, runner, runId, path, {
                            maxWindows: options.maxWindows,
                            maxPerSession: options.maxPerSession,
                            hedgeAfterMs: options.hedgeAfterMs,
                            dry: options.dry,
                        }),
                    {
                        concurrency: sessionConcurrency,
                        // One unreadable transcript must not lose the other 19 sessions.
                        onError: (error, item) => {
                            failed++;
                            logger.warn({ session: item, error }, "session mining failed — skipped");
                        },
                    }
                )
                .map(
                    "persist-session",
                    (result) => {
                        done++;
                        if (!options.dry && runner) {
                            persistSessionResult(config, runner, result);
                            out.log.step(
                                `[${done}/${sessionPaths.length}] ${result.stem.slice(0, 8)}: ` +
                                    `${result.episodes.length} episodes, ${result.principles.length} principles, ` +
                                    `${Math.round(result.secs)}s`
                            );
                        } else {
                            out.log.info(
                                `[${done}/${sessionPaths.length}] ${result.stem.slice(0, 8)}: ${result.turns} turns ` +
                                    `(${result.fableTurns} fable), ${result.windows} windows ` +
                                    `(${result.windowsSampled} sampled)`
                            );
                        }

                        episodes += result.episodes.length;
                        principles += result.principles.length;
                        summaries.push({
                            stem: result.stem,
                            turns: result.turns,
                            fableTurns: result.fableTurns,
                            windows: result.windows,
                            windowsSampled: result.windowsSampled,
                            episodes: result.episodes.length,
                            principles: result.principles.length,
                            extractorFailures: result.extractorFailures,
                            secs: Math.round(result.secs * 10) / 10,
                        });
                        setOutputs({ sessions: summaries, episodes, principles, failed });
                    },
                    { concurrency: 1 }
                )
                .drain();

            if (failed) {
                out.log.warn(`${failed}/${sessionPaths.length} sessions failed to mine — see the log for each`);
            }

            if (options.json) {
                out.result({ runId, model: runner?.id, sessions: summaries, episodes, principles, failed });
            } else if (!options.dry) {
                out.log.success(
                    `mined ${sessionPaths.length - failed} sessions → ${episodes} episodes, ` +
                        `${principles} principle candidates`
                );
            }
        }
    );
}
