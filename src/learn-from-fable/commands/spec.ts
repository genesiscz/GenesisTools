import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { type FableConfig, packPaths, requireStageModel } from "../lib/config";
import { runStage } from "../lib/manifest";
import type { ReasoningEffort } from "../lib/runners";
import { createRunner } from "../lib/runners";
import type { SpecCandidate } from "../lib/stages/spec";
import { synthesizeSpec } from "../lib/stages/spec";

export interface SpecCommandOptions {
    /** Model that writes the spec (default: config models.judge). */
    model?: string;
    /** Reasoning effort for the synthesis call. */
    effort?: ReasoningEffort;
    maxLines: number;
    minConfidence: number;
    /** Candidates per synthesis call. */
    batch?: number;
    /** Seconds of silence before a pass is abandoned and retried. */
    firstOutputSecs?: number;
    /** Skip raw (unvoted) candidates and use consolidated principles only. */
    consolidatedOnly?: boolean;
    /** Final pass that splits oversized bullets back into principles (default on). */
    tighten?: boolean;
    /** Explicit output path; must not be the canonical spec. */
    out?: string;
    json?: boolean;
}

function loadCandidates(path: string): SpecCandidate[] {
    if (!existsSync(path)) {
        return [];
    }

    const principles: SpecCandidate[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            principles.push(SafeJSON.parse(line, { strict: true }) as SpecCandidate);
        } catch (err) {
            logger.debug({ error: err, path }, "bad principle line skipped");
        }
    }

    return principles;
}

/** Same habit, same session, same miner — one candidate. Consolidated wins (it carries a confidence). */
function dedupe(consolidated: SpecCandidate[], raw: SpecCandidate[]): SpecCandidate[] {
    const key = (p: SpecCandidate) => `${p.sessionStem}|${p.minedBy}|${p.principle.trim().toLowerCase()}`;
    const byKey = new Map<string, SpecCandidate>();
    for (const p of raw) {
        byKey.set(key(p), p);
    }

    for (const p of consolidated) {
        byKey.set(key(p), p);
    }

    return [...byKey.values()];
}

export async function specCommand(config: FableConfig, options: SpecCommandOptions): Promise<void> {
    const paths = packPaths(config);
    const model = requireStageModel(config, "judge", options.model);
    const consolidated = loadCandidates(join(paths.principlesDir, "consolidated.jsonl"));
    const raw = options.consolidatedOnly ? [] : loadCandidates(join(paths.principlesDir, "unconsolidated.jsonl"));
    const principles = dedupe(consolidated, raw);

    if (!principles.length) {
        out.log.info("No principle candidates yet — run mine first.");
        return;
    }

    const runner = createRunner({ model, effort: options.effort });

    await runStage(
        config,
        {
            stage: "spec",
            model: runner.id,
            params: {
                maxLines: options.maxLines,
                minConfidence: options.minConfidence,
                batch: options.batch,
                firstOutputSecs: options.firstOutputSecs,
                consolidatedOnly: options.consolidatedOnly ?? false,
                tighten: options.tighten !== false,
            },
            inputs: {
                consolidated: consolidated.length,
                unconsolidated: raw.length,
                candidates: principles.length,
                spec: paths.spec,
            },
        },
        async ({ runId, setOutputs }) => {
            // Resolve and guard the destination BEFORE spending a synthesis call:
            // the canonical spec is hand-owned, and an automated rewrite of it would
            // destroy curation with no undo.
            const target = resolve(options.out ?? join(dirname(paths.spec), `FABLE-SPEC.${runId}.md`));
            if (target === resolve(paths.spec)) {
                throw new Error(
                    `refusing to overwrite the canonical spec at ${paths.spec} — write a proposal elsewhere and promote it yourself`
                );
            }

            if (existsSync(target)) {
                throw new Error(`refusing to overwrite an existing file: ${target}`);
            }

            const result = await synthesizeSpec(runner, paths.spec, principles, {
                maxLines: options.maxLines,
                minConfidence: options.minConfidence,
                batchSize: options.batch,
                firstOutputMs: options.firstOutputSecs ? options.firstOutputSecs * 1000 : undefined,
                tighten: options.tighten,
            });

            await Bun.write(target, result.markdown);
            setOutputs({ ...result, markdown: undefined, target });

            if (options.json) {
                out.result({ ...result, markdown: undefined, target });
                return;
            }

            out.log.success(
                `spec proposal written: ${result.beforeLines} → ${result.afterLines} lines, ` +
                    `${result.beforeBullets} → ${result.afterBullets} bullets, ` +
                    `${result.afterOverCap} oversized${result.tightened ? " after tightening" : ""}, ` +
                    `from ${result.principlesFed} candidates (${result.vettedFed} vetted, ${result.unvettedFed} raw) ` +
                    `in ${result.batches} merge passes (${result.rejectedPasses} rejected for erosion, budget ${options.maxLines})`
            );
            out.println(target);
            out.log.info("Review, then promote it yourself — this stage never touches the canonical spec:");
            out.println(`  diff -u "${paths.spec}" "${target}" | less`);
            out.println(`  cp "${target}" "${paths.spec}"   # only after you agree with the diff`);
            out.println(`  tools learn-from-fable skill --max-lines 150 --sync   # regenerate the skill from it`);
        }
    );
}
