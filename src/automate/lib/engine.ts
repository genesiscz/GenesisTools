// src/automate/lib/engine.ts

// Register all step handlers (http, file, git, json, text, array, notify, parallel, loop)
import "./steps/index";

import { formatDuration } from "@app/utils/format.ts";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { RunLogger } from "./run-logger.ts";
import { executeStep, isParallelChild, setStepRunnerMeta } from "./step-runner.ts";
import { updatePresetMeta } from "./storage.ts";
import type { ExecutionContext, ParallelStepParams, Preset, RunOptions, StepResult } from "./types.ts";

export interface EngineResult {
    preset: string;
    success: boolean;
    steps: Array<{
        id: string;
        name: string;
        result: StepResult;
    }>;
    totalDuration: number;
}

/**
 * Execute a preset end-to-end.
 * 1. Build execution context from preset defaults + CLI overrides
 * 2. Prompt for missing required variables
 * 3. Walk the step array, executing each step
 * 4. Handle conditional jumps, error strategies, and output capture
 * 5. Update run metadata
 */
export async function runPreset(
    preset: Preset,
    options: RunOptions = {},
    runLogger?: RunLogger
): Promise<EngineResult> {
    const totalStart = Date.now();

    // Build initial context
    const ctx = buildContext(preset, options);

    // Prompt for any required vars that are missing
    await promptForMissingVars(preset, ctx);

    const results: EngineResult["steps"] = [];

    if (options.dryRun) {
        p.log.warn(pc.yellow("DRY RUN -- no commands will be executed"));
    }

    // Build a step-ID-to-index map for jump targets
    const stepIndex = new Map(preset.steps.map((s, i) => [s.id, i]));

    // Collect parallel child IDs so the main loop can skip them
    const parallelChildIds = new Set<string>();
    for (const s of preset.steps) {
        if (s.action === "parallel" && s.params) {
            const pParams = s.params as unknown as ParallelStepParams;
            if (pParams.steps) {
                for (const childId of pParams.steps) {
                    parallelChildIds.add(childId);
                }
            }
        }
    }

    // Inject runtime metadata for step handlers (parallel, forEach, etc.)
    setStepRunnerMeta({ allSteps: preset.steps, parallelChildIds });

    let i = 0;
    while (i < preset.steps.length) {
        const step = preset.steps[i];

        // Skip steps that are managed by a parallel handler
        if (isParallelChild(step.id)) {
            i++;
            continue;
        }

        const stepLabel = `[${i + 1}/${preset.steps.length}] ${step.name}`;

        // --- Dry run: just log what would happen ---
        if (options.dryRun) {
            p.log.step(pc.dim(stepLabel));
            const { result } = await executeStep(step, ctx, { dryRun: true, verbose: options.verbose });
            if (typeof result.output === "string" && result.output) {
                p.log.info(pc.dim(`  ${result.output}`));
            }
            ctx.steps[step.id] = result;
            results.push({ id: step.id, name: step.name, result });
            i++;
            continue;
        }

        // --- Real execution with spinner ---
        const spinner = p.spinner();
        spinner.start(stepLabel);

        try {
            const { result, jumpTo } = await executeStep(step, ctx, {
                dryRun: false,
                verbose: options.verbose,
            });

            // Store result in context for subsequent expression references
            ctx.steps[step.id] = result;

            results.push({ id: step.id, name: step.name, result });

            // Log step to SQLite
            runLogger?.logStep(i, step.id, step.name, step.action, result);

            if (result.status === "success") {
                spinner.stop(pc.green(`${stepLabel} (${formatDuration(result.duration)})`));
            } else if (result.status === "error") {
                spinner.stop(pc.red(`${stepLabel} FAILED`));

                if (result.error) {
                    p.log.error(result.error);
                }

                const errorStrategy = step.onError ?? "stop";
                if (errorStrategy === "stop") {
                    p.log.error("Stopping execution due to step failure (onError: stop)");
                    break;
                }
                // "continue" and "skip" both move to next step
            }

            // Handle conditional jumps (from "if" action)
            if (jumpTo) {
                const targetIndex = stepIndex.get(jumpTo);
                if (targetIndex === undefined) {
                    spinner.stop(pc.red(`${stepLabel} - jump target "${jumpTo}" not found`));
                    break;
                }
                i = targetIndex;
                continue;
            }
        } catch (error) {
            spinner.stop(pc.red(`${stepLabel} EXCEPTION`));
            const errorMsg = error instanceof Error ? error.message : String(error);
            p.log.error(errorMsg);

            const exceptionResult: StepResult = {
                status: "error",
                output: null,
                duration: 0,
                error: errorMsg,
            };
            // Make the error result available to subsequent steps via ctx.steps
            ctx.steps[step.id] = exceptionResult;
            results.push({ id: step.id, name: step.name, result: exceptionResult });

            runLogger?.logStep(i, step.id, step.name, step.action, exceptionResult);

            const errorStrategy = step.onError ?? "stop";
            if (errorStrategy === "stop") break;
        }

        i++;
    }

    const totalDuration = Date.now() - totalStart;
    const allSuccess = results.every((r) => r.result.status === "success" || r.result.status === "skipped");

    // Finish run logging
    runLogger?.finishRun(
        allSuccess,
        results.length,
        totalDuration,
        allSuccess ? undefined : results.find((r) => r.result.status === "error")?.result.error
    );

    // Update run metadata (skip for dry runs)
    if (!options.dryRun) {
        try {
            await updatePresetMeta(preset.name);
        } catch {
            // Non-critical metadata update failure
        }
    }

    return {
        preset: preset.name,
        success: allSuccess,
        steps: results,
        totalDuration,
    };
}

/**
 * Build the initial execution context from preset variable defaults,
 * CLI --var overrides, and process.env.
 */
function buildContext(preset: Preset, options: RunOptions): ExecutionContext {
    const vars: Record<string, string | number | boolean> = {};

    // Apply defaults from preset variable definitions
    if (preset.vars) {
        for (const [key, def] of Object.entries(preset.vars)) {
            if (def.default !== undefined) {
                vars[key] = def.default;
            }
        }
    }

    // Apply CLI overrides (--var key=value)
    if (options.vars) {
        for (const varStr of options.vars) {
            const eqIndex = varStr.indexOf("=");
            if (eqIndex === -1) {
                p.log.warn(`Invalid --var format: "${varStr}" (expected key=value)`);
                continue;
            }
            const key = varStr.slice(0, eqIndex);
            const value = varStr.slice(eqIndex + 1);
            vars[key] = value;
        }
    }

    return {
        vars,
        steps: {},
        env: process.env as Record<string, string>,
    };
}

/**
 * Interactively prompt for any required variables that don't have a value yet.
 * Variables with `required: false` are skipped if missing.
 * Variables with a default value are pre-populated and not prompted.
 */
async function promptForMissingVars(preset: Preset, ctx: ExecutionContext): Promise<void> {
    if (!preset.vars) return;

    for (const [key, def] of Object.entries(preset.vars)) {
        // Already has a value (from default or CLI override)
        if (ctx.vars[key] !== undefined) continue;

        // Skip explicitly optional vars
        if (def.required === false) continue;

        // Prompt for the missing required variable
        const answer = await p.text({
            message: def.description || `Enter value for "${key}":`,
            placeholder: def.default != null ? String(def.default) : undefined,
            defaultValue: def.default != null ? String(def.default) : undefined,
        });

        if (p.isCancel(answer)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        // Coerce to the declared type
        if (def.type === "number") {
            ctx.vars[key] = Number(answer);
        } else if (def.type === "boolean") {
            ctx.vars[key] = answer === "true";
        } else {
            ctx.vars[key] = answer;
        }
    }
}
