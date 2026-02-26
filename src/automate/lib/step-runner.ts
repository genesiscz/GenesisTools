import logger from "@app/logger.ts";
import { runTool } from "@app/utils/cli/tools";
import { executeBuiltin, isBuiltinAction } from "./builtins.ts";
import { resolveExpression, resolveParams } from "./expressions.ts";
import type { StepContext } from "./registry.ts";
import { resolveStepHandler } from "./registry.ts";
import type { ExecutionContext, PresetStep, StepResult } from "./types.ts";

/**
 * Execute a single step.
 * - Built-in actions (if, log, prompt, shell, set) are dispatched to builtins.ts.
 * - Everything else is treated as a `tools <action>` command spawned via Bun.spawn.
 *
 * Returns the StepResult and an optional jumpTo step ID (from `if` actions).
 */
export async function executeStep(
    step: PresetStep,
    ctx: ExecutionContext,
    options: { dryRun?: boolean; verbose?: boolean },
): Promise<{ result: StepResult; jumpTo?: string }> {
    // Dispatch built-in actions
    if (isBuiltinAction(step.action)) {
        if (options.dryRun) {
            return {
                result: { status: "skipped", output: `[dry-run] built-in: ${step.action}`, duration: 0 },
            };
        }
        return executeBuiltin(step, ctx);
    }

    // Check registry for extended step handlers (http, file, git, json, etc.)
    const registryHandler = resolveStepHandler(step.action);
    if (registryHandler) {
        if (options.dryRun) {
            return {
                result: { status: "skipped", output: `[dry-run] registry handler: ${step.action}`, duration: 0 },
            };
        }
        const stepCtx = buildStepContext(ctx);
        const result = await registryHandler(step, stepCtx);
        return { result };
    }

    // Build the full tools command args
    const args = buildToolsArgs(step, ctx);

    if (options.dryRun) {
        return {
            result: {
                status: "skipped",
                output: `Would run: tools ${args.join(" ")}`,
                duration: 0,
            },
        };
    }

    if (options.verbose) {
        logger.debug(`Executing: tools ${args.join(" ")}`);
    }

    const start = Date.now();
    const toolResult = await runTool(args);
    const stdout = toolResult.stdout;
    const stderr = toolResult.stderr;
    const exitCode = toolResult.exitCode;

    // Try to parse stdout as JSON for structured access via expressions
    let output: unknown = stdout.trim();
    try {
        output = JSON.parse(stdout);
    } catch {
        // Keep as raw string
    }

    const result: StepResult = {
        status: exitCode === 0 ? "success" : "error",
        output,
        exitCode,
        duration: Date.now() - start,
        error: exitCode !== 0 ? stderr.trim() || `Exit code: ${exitCode}` : undefined,
    };

    return { result };
}

/**
 * Build CLI args array from step action + resolved params.
 *
 * The action string is split on whitespace to form the initial args.
 * Then params are appended:
 *   - Keys starting with "--" or "-" become flags.
 *     - Boolean true: flag is included. Boolean false: flag is omitted.
 *     - Arrays: joined with comma.
 *     - Other values: stringified.
 *   - Keys NOT starting with "-" are positional arguments (value only, key ignored).
 *
 * Example:
 *   action="github search", params={"query": "bug", "--repo": "owner/repo", "--format": "json"}
 *   => ["github", "search", "bug", "--repo", "owner/repo", "--format", "json"]
 */
function buildToolsArgs(step: PresetStep, ctx: ExecutionContext): string[] {
    const parts = step.action.split(/\s+/);

    if (!step.params) {
        return parts;
    }

    const resolved = resolveParams(step.params as Record<string, unknown>, ctx);
    const args: string[] = [...parts];

    for (const [key, value] of Object.entries(resolved)) {
        if (key.startsWith("--") || key.startsWith("-")) {
            // Flag parameter
            if (typeof value === "boolean") {
                if (value) {
                    args.push(key);
                }
                // false = omit the flag entirely
            } else if (Array.isArray(value)) {
                args.push(key, value.join(","));
            } else {
                args.push(key, String(value));
            }
        } else {
            // Positional parameter (key name like "query" is just a label)
            if (Array.isArray(value)) {
                args.push(...value.map(String));
            } else {
                args.push(String(value));
            }
        }
    }

    return args;
}

/** Runtime metadata injected by the engine for extended step handlers */
interface StepRunnerMeta {
    allSteps?: PresetStep[];
    parallelChildIds?: Set<string>;
}

/** Module-level metadata that the engine can set before running steps */
let runnerMeta: StepRunnerMeta = {};

/**
 * Set runtime metadata for step handlers (called by the engine before the step loop).
 * Provides allSteps for parallel handler and parallelChildIds for skipping.
 */
export function setStepRunnerMeta(meta: StepRunnerMeta): void {
    runnerMeta = meta;
}

/**
 * Check if a step should be skipped in the main loop (because it runs inside parallel).
 */
export function isParallelChild(stepId: string): boolean {
    return runnerMeta.parallelChildIds?.has(stepId) ?? false;
}

/**
 * Build a StepContext from the ExecutionContext.
 * Maps the engine's context to the registry handler interface.
 */
function buildStepContext(ctx: ExecutionContext): StepContext {
    return {
        steps: ctx.steps,
        variables: ctx.vars,
        env: ctx.env,
        evaluate: (expr: string) => {
            // Intercept __allSteps for parallel handler
            if (expr === "__allSteps") {
                return runnerMeta.allSteps;
            }
            return resolveExpression(`{{ ${expr} }}`, ctx);
        },
        interpolate: (template: string) => {
            const result = resolveExpression(template, ctx);
            return typeof result === "string" ? result : JSON.stringify(result);
        },
        log: (level, message) => {
            logger[level]?.(message) ?? logger.info(message);
        },
    };
}
