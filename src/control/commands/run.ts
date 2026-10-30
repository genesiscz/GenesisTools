import { existsSync, readFileSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { CaptureRunError } from "../lib/capture-runner";
import { executePlan, type PlanStepResult, parsePlanDocument, stepLabel } from "../lib/plan-runner";
import type { AxResult } from "../lib/runner";

export { resolveTemplates, validatePlan } from "../lib/plan-runner";

interface RunOptions {
    json?: boolean;
    pretty?: boolean;
    plan?: string;
    stopOnFail?: boolean;
    stealFocus?: boolean;
    dryRun?: boolean;
}

/** Step line with the failure reason inline — a failing plan must say WHY without --json. */
function printStep(label: string, result: AxResult, ms: number): void {
    if (result.ok) {
        out.println(`  ${pc.green("ok")} ${pc.cyan(label)} ${pc.dim(`${ms}ms`)}`);
        return;
    }
    const actual =
        typeof result.actual === "string"
            ? result.actual
            : result.actual != null
              ? `actual: ${SafeJSON.stringify(result.actual)}`
              : undefined;
    const parts = [result.error, actual].filter(Boolean).join(" — ");
    out.println(
        `  ${pc.red("FAIL")} ${pc.cyan(label)} ${pc.dim(`${ms}ms`)}${parts ? ` — ${parts.slice(0, 200)}` : ""}`
    );
}

export function registerRunCommand(program: Command): void {
    program
        .command("run [plan]")
        .description(`Execute a plan file — ONE schema for sequential steps, timed timelines, and recordings.

  Plan contract (JSON):
    {
      "app":      "Genesis",         // default app for all steps
      "restore":  true,              // snapshot before, restore after
      "delayMs":  300,               // pause between steps (ms, default 200; ignored when atMs is used)
      "exact":    false,             // force strict role matching
      "capture":  { ... },           // OPTIONAL — present = record video around the timeline
                                     //   (full recording contract: ${toolCommand("control capture")} --help)
      "steps": [
        { "do": "focus" },
        { "do": "press", "q": "Chat" },
        { "do": "click", "desc": "Account", "role": "button" },
        { "do": "set", "id": "field-id", "value": "hello" },
        { "atMs": 2000, "do": "screenshot", "path": "/path/to/shot.png" },
        { "do": "hotkey", "keys": "cmd,w" },
        { "do": "click", "subrole": "close", "window": "Settings" }
      ]
    }

  Modes (decided by the plan, same schema):
    - no atMs anywhere  -> sequential: run each step, wait delayMs between
    - any step has atMs -> timeline: steps fire at their atMs offset from start
                           (steps without atMs run back-to-back after the previous)
    - capture{} present -> the ENTIRE plan is handed to the capture runner
                           ("steps" is accepted as an alias for its "actions")

  Step fields: do (command), atMs, q (universal search), id, role, title, desc,
    subrole, window, value, text, path, keys, action, crop, delay, app (override).
  wait/assert steps also take: gone, for ("enabled"|"focused"), expect,
    contains, timeout, interval — e.g. { "do": "wait", "q": "Save", "gone": true },
    { "do": "assert", "id": "status", "contains": "Done" }.
  Action aliases: ax-set/ax-press/ax-perform map to set/press/perform.
  Role/subrole fuzzy by default: "button" matches AXButton.

  Result semantics: top-level ok is true only when EVERY step succeeded;
  failedSteps carries the count, steps[] the per-step results, each with
  its result JSON and ms wall-clock timing.`)
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .option("--plan <json>", "the plan itself, inline — alternative to a path or to `-`")
        .option("--stop-on-fail", "stop at the first failed step and report the rest as skipped")
        .option(
            "--steal-focus",
            "let type/set/hotkey steps run while another app is frontmost (a demonstration the user asked for); config: focusStealGuard"
        )
        .option("--dry-run", "validate every step and resolve nothing else: prints what would run, touches no UI")
        .action(async (planPath: string | undefined, opts: RunOptions) => {
            // Three doors to the same plan. An agent holds the plan in memory, so
            // making a temp file the only way in meant every caller wrote one.
            let planText: string;

            if (opts.plan) {
                planText = opts.plan;
            } else if (planPath === "-") {
                planText = await Bun.stdin.text();
            } else if (planPath) {
                if (!existsSync(planPath)) {
                    logger.error(`plan file not found: ${planPath}`);
                    process.exit(1);
                }

                planText = readFileSync(planPath, "utf-8");
            } else {
                logger.error("pass a plan file, `-` to read stdin, or --plan '<json>'");
                process.exit(1);
            }

            const plan = parsePlanDocument(SafeJSON.parse(planText));
            const onStep = opts.json
                ? undefined
                : (entry: PlanStepResult) => {
                      const attempts = entry.attempts ?? 1;
                      printStep(
                          `${stepLabel(entry.step)}${attempts > 1 ? ` (${attempts} attempts)` : ""}`,
                          entry.result,
                          entry.ms
                      );
                  };
            let outcome: Awaited<ReturnType<typeof executePlan>>;

            try {
                outcome = await executePlan({
                    plan,
                    stopOnFail: opts.stopOnFail,
                    stealFocus: opts.stealFocus,
                    dryRun: opts.dryRun,
                    onStep,
                });
            } catch (e) {
                if (e instanceof CaptureRunError) {
                    logger.error(e.message);
                    process.exit(e.exitCode);
                }

                throw e;
            }

            const json = (value: unknown) => out.println(SafeJSON.stringify(value, null, opts.pretty ? 2 : 0));

            if (outcome.kind === "invalid") {
                if (opts.json) {
                    json({ ok: false, problems: outcome.problems });
                } else {
                    for (const problem of outcome.problems) {
                        out.println(`  ${pc.red("INVALID")} ${problem}`);
                    }
                }

                process.exit(1);
            }

            if (outcome.kind === "dry-run") {
                if (opts.json) {
                    json({ ok: true, dryRun: true, capture: outcome.capture, steps: outcome.steps });
                } else {
                    for (const entry of outcome.steps) {
                        out.println(`  ${pc.dim(String(entry.index))} ${pc.cyan(entry.do)} ${pc.dim(entry.app)}`);
                    }

                    out.println(`\n${outcome.steps.length} step(s) valid; nothing was run.`);
                }

                process.exit(0);
            }

            if (outcome.kind === "capture") {
                out.println(SafeJSON.stringify(outcome.result, null, 2));
                process.exit(outcome.captureFailed ? 1 : 0);
            }

            const report = outcome.report;

            if (opts.json) {
                json(report);
            } else {
                if (report.restored) {
                    out.println(`  ${pc.green("restored")} mouse + focus`);
                }

                // Count what actually succeeded. `length - failedSteps` folded the
                // skipped steps into "passed" once they stopped counting as failed.
                const passed = report.steps.filter((r) => r.result.ok).length;
                const totalMs = report.steps.reduce((s, r) => s + r.ms, 0);
                out.println(
                    `\n${passed}/${report.totalSteps} steps passed, ${totalMs}ms total${
                        report.skippedSteps > 0
                            ? `, ${report.skippedSteps} skipped after step ${report.stoppedAtStep} failed`
                            : ""
                    }`
                );
            }

            if (report.failedSteps > 0) {
                process.exit(1);
            }
        });
}
