/**
 * A/B eval — the "measure, don't train" replacement for SkillOpt's train loop.
 * For each episode: ask the eval model for its next move BARE, then again with
 * the fable-style skill injected into the system prompt; judge both against the
 * reference. The delta is the skill's measured effect.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { pipeline } from "@genesiscz/utils/pipeline";
import { ensureMetaDirs, type FableConfig, packPaths, STAGE_CONCURRENCY } from "../config";
import type { Runner } from "../runners";
import { type JudgeItem, type JudgeVerdict, judgeBatch } from "./judge";
import type { Episode } from "./types";

/** Flush a partial judge batch after this long with no new answer. */
const JUDGE_BATCH_IDLE_MS = 5_000;

const TASK_FRAMING =
    "You are the agent in the transcript below, at the moment marked. Decide the " +
    "single best next move — the concrete command(s) you would run or the exact " +
    "message you would send to the user. Be specific to THIS situation.";

export interface EvalOptions {
    judgeBatchSize: number;
    timeoutMs?: number;
    /** Model calls in flight at once (default STAGE_CONCURRENCY). */
    concurrency?: number;
}

export interface ArmStats {
    n: number;
    meanSoft: number;
    hardRate: number;
}

export interface EvalResult {
    /** Episodes the run asked for; an arm with n < requested lost candidates or verdicts. */
    requested: number;
    bare: ArmStats;
    withSkill: ArmStats;
    /** Non-empty when an arm was lost (n=0) or partial (n < requested). */
    warnings: string[];
    perEpisode: {
        id: string;
        taskType: string;
        bareSoft?: number;
        skillSoft?: number;
        bareVerdict?: string;
        skillVerdict?: string;
    }[];
}

function stats(verdicts: JudgeVerdict[]): ArmStats {
    const n = verdicts.length;
    if (!n) {
        return { n: 0, meanSoft: 0, hardRate: 0 };
    }

    return {
        n,
        meanSoft: Math.round((verdicts.reduce((s, v) => s + v.soft, 0) / n) * 10_000) / 10_000,
        hardRate: Math.round((verdicts.reduce((s, v) => s + v.hard, 0) / n) * 10_000) / 10_000,
    };
}

export function loadSkillText(config: FableConfig): string {
    const path = join(packPaths(config).skillDir, "SKILL.md");
    if (!existsSync(path)) {
        throw new Error(`No skill to evaluate at ${path}`);
    }

    return readFileSync(path, "utf-8");
}

export async function runAbEval(
    config: FableConfig,
    episodes: Episode[],
    evalRunner: Runner,
    judgeRunner: Runner,
    options: EvalOptions
): Promise<EvalResult> {
    const skill = loadSkillText(config);

    const concurrency = options.concurrency ?? STAGE_CONCURRENCY;
    const replies = new Map<string, { bare?: string; withSkill?: string }>();

    /**
     * One arm end to end: answers stream into judge batches as they land, so the
     * judge is working while the eval model is still answering later episodes.
     * Both arms run this at the same time.
     */
    const runArm = async (arm: "bare" | "withSkill", system: string) => {
        const verdicts = new Map<string, JudgeVerdict>();
        await pipeline(episodes, { scope: "lff-eval" })
            .map(
                `${arm}-answer`,
                async (ep) => {
                    const reply = await evalRunner.call({
                        system,
                        user: ep.contextPrefix,
                        maxTokens: 3000,
                        timeoutMs: options.timeoutMs,
                        label: `${arm}-${ep.id.slice(-4)}`,
                    });
                    if (!reply.text.trim()) {
                        return undefined;
                    }

                    const entry = replies.get(ep.id) ?? {};
                    entry[arm] = reply.text;
                    replies.set(ep.id, entry);
                    return { episode: ep, candidate: reply.text } satisfies JudgeItem;
                },
                {
                    concurrency,
                    onError: (error, item) =>
                        logger.warn({ id: (item as Episode).id, arm, error }, "eval arm call failed"),
                }
            )
            .batch(`${arm}-judge-batch`, { size: options.judgeBatchSize, maxWaitMs: JUDGE_BATCH_IDLE_MS })
            .map(
                `${arm}-judge`,
                async (batch) => {
                    for (const [id, v] of await judgeBatch(judgeRunner, batch, options.timeoutMs)) {
                        verdicts.set(id, v);
                    }
                },
                { concurrency, onError: (error) => logger.warn({ arm, error }, "eval judge batch failed") }
            )
            .drain();

        return verdicts;
    };

    const [bareVerdicts, skillVerdicts] = await Promise.all([
        runArm("bare", TASK_FRAMING),
        runArm("withSkill", `${TASK_FRAMING}\n\n## Operating skill\n${skill}`),
    ]);

    const bare = stats([...bareVerdicts.values()]);
    const withSkill = stats([...skillVerdicts.values()]);
    const warnings: string[] = [];
    for (const [arm, armStats] of [
        ["bare", bare],
        ["withSkill", withSkill],
    ] as const) {
        if (armStats.n === 0) {
            warnings.push(`${arm} arm LOST: 0/${episodes.length} episodes judged (its numbers are meaningless)`);
        } else if (armStats.n < episodes.length) {
            warnings.push(`${arm} arm PARTIAL: only ${armStats.n}/${episodes.length} episodes judged`);
        }
    }

    const result: EvalResult = {
        requested: episodes.length,
        bare,
        withSkill,
        warnings,
        perEpisode: episodes.map((ep) => ({
            id: ep.id,
            taskType: ep.taskType,
            bareSoft: bareVerdicts.get(ep.id)?.soft,
            skillSoft: skillVerdicts.get(ep.id)?.soft,
            bareVerdict: bareVerdicts.get(ep.id)?.verdict,
            skillVerdict: skillVerdicts.get(ep.id)?.verdict,
        })),
    };

    out.log.success(
        `A/B: bare soft=${result.bare.meanSoft} hard=${result.bare.hardRate} (n=${result.bare.n}) | ` +
            `+skill soft=${result.withSkill.meanSoft} hard=${result.withSkill.hardRate} (n=${result.withSkill.n})`
    );

    for (const warning of warnings) {
        logger.warn({ warning, requested: episodes.length }, "eval arm incomplete");
        out.log.warn(warning);
    }

    return result;
}

export function persistEvalRun(
    config: FableConfig,
    runId: string,
    models: { eval: string; judge: string },
    result: EvalResult
): void {
    const paths = ensureMetaDirs(config);
    appendFileSync(
        join(paths.metaDir, "eval-runs.jsonl"),
        `${SafeJSON.stringify({ runId, at: new Date().toISOString(), models, ...result }, { strict: true })}\n`
    );
}
