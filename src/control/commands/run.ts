import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { type AxResult, runAx } from "../lib/runner";
import { assertEl, waitFor } from "./verify";

const ACTION_ALIASES: Record<string, string> = {
    "ax-set": "set",
    "ax-press": "press",
    "ax-perform": "perform",
    axSet: "set",
    axPress: "press",
    axPerform: "perform",
};

const NO_APP_COMMANDS = new Set(["snapshot", "restore", "hotkey", "apps"]);

const KNOWN_STEP_COMMANDS = new Set([
    "focus",
    "press",
    "click",
    "set",
    "type",
    "get",
    "find",
    "attrs",
    "actions",
    "perform",
    "window",
    "scroll",
    "hotkey",
    "screenshot",
    "ocr",
    "wait",
    "assert",
    "snapshot",
    "restore",
    "apps",
]);

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
        .command("run <plan>")
        .description(`Execute a plan file — ONE schema for sequential steps, timed timelines, and recordings.

  Plan contract (JSON):
    {
      "app":      "Genesis",         // default app for all steps
      "restore":  true,              // snapshot before, restore after
      "delayMs":  300,               // pause between steps (ms, default 200; ignored when atMs is used)
      "exact":    false,             // force strict role matching
      "capture":  { ... },           // OPTIONAL — present = record video around the timeline
                                     //   (full recording contract: tools control capture --help)
      "steps": [
        { "do": "focus" },
        { "do": "press", "q": "Chat" },
        { "do": "click", "desc": "Account", "role": "button" },
        { "do": "set", "id": "field-id", "value": "hello" },
        { "atMs": 2000, "do": "screenshot", "path": "/tmp/shot.png" },
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
        .action((planPath, opts) => {
            if (!existsSync(planPath)) {
                logger.error(`plan file not found: ${planPath}`);
                process.exit(1);
            }
            const plan = SafeJSON.parse(readFileSync(planPath, "utf-8")) as {
                app?: string;
                restore?: boolean;
                delayMs?: number;
                exact?: boolean;
                capture?: Record<string, unknown>;
                actions?: Array<Record<string, unknown>>;
                steps?: Array<Record<string, unknown>>;
            };

            // Recording plans: the capture runner owns the whole timeline.
            // Normalize BEFORE delegating — the runner reads `actions` with its
            // own ax-prefixed verbs and axId targeting; the unified schema
            // promises `steps` + plain verbs + `id` work here too.
            if (plan.capture) {
                const CAPTURE_VERBS: Record<string, string> = {
                    press: "ax-press",
                    set: "ax-set",
                    perform: "ax-perform",
                };
                const rawActions = plan.actions ?? plan.steps ?? [];
                const normalized: Record<string, unknown> = { ...plan };
                delete normalized.steps;
                normalized.actions = rawActions.map((a) => {
                    const step: Record<string, unknown> = { ...a };
                    const verb = CAPTURE_VERBS[String(step.do ?? "")];
                    if (verb) {
                        step.do = verb;
                    }
                    if (step.id != null && step.axId == null) {
                        step.axId = step.id;
                        delete step.id;
                    }
                    if (step.app == null && plan.app) {
                        step.app = plan.app;
                    }
                    return step;
                });
                const tmpPath = join(tmpdir(), `control-run-capture-${process.pid}.json`);
                writeFileSync(tmpPath, SafeJSON.stringify(normalized));
                const script = join(import.meta.dir, "..", "lib", "capture-with-actions.ts");
                const r = spawnSync("bun", [script, tmpPath], { stdio: "inherit" });
                try {
                    unlinkSync(tmpPath);
                } catch {
                    // best-effort cleanup
                }
                process.exit(r.status ?? 1);
            }

            const steps = plan.steps ?? plan.actions ?? [];
            if (!steps.length) {
                logger.error("plan has no steps");
                process.exit(1);
            }

            const timeline = steps.some((s) => typeof s.atMs === "number");
            const delay = plan.delayMs ?? 200;
            let snapshot: AxResult | null = null;

            if (plan.restore) {
                snapshot = runAx(["snapshot"]);
            }

            const startedAt = performance.now();
            const results: Array<{ step: Record<string, unknown>; result: AxResult; ms: number }> = [];
            for (const step of steps) {
                let cmd = String(step.do ?? "");
                cmd = ACTION_ALIASES[cmd] ?? cmd;
                const app = String(step.app ?? plan.app ?? "");
                if (!cmd) {
                    results.push({ step, result: { ok: false, error: "missing 'do'" }, ms: 0 });
                    continue;
                }
                if (!KNOWN_STEP_COMMANDS.has(cmd)) {
                    const result: AxResult = {
                        ok: false,
                        error: `unknown step command '${cmd}' — valid: ${[...KNOWN_STEP_COMMANDS].join(", ")}`,
                    };
                    results.push({ step, result, ms: 0 });
                    if (!opts.json) {
                        printStep(cmd, result, 0);
                    }
                    continue;
                }

                if (timeline && typeof step.atMs === "number") {
                    const wait = step.atMs - (performance.now() - startedAt);
                    if (wait > 0) {
                        Bun.sleepSync(wait);
                    }
                }

                // wait/assert are TS-side condition steps, not binary commands.
                if (cmd === "wait" || cmd === "assert") {
                    const target: string[] = [];
                    for (const k of ["q", "id", "role", "title", "desc", "subrole", "window", "depth"]) {
                        if (step[k] != null) {
                            target.push(`--${k}`, String(step[k]));
                        }
                    }
                    const cond = {
                        app,
                        target,
                        gone: step.gone === true,
                        for: step.for as string | undefined,
                        value: step.expect as string | undefined,
                        contains: step.contains as string | undefined,
                    };
                    const t0w = performance.now();
                    const result =
                        cmd === "wait"
                            ? waitFor({
                                  ...cond,
                                  timeout: typeof step.timeout === "number" ? step.timeout : 5000,
                                  interval: typeof step.interval === "number" ? step.interval : 200,
                              })
                            : assertEl(cond);
                    const msW = Math.round(performance.now() - t0w);
                    results.push({ step, result, ms: msW });
                    if (!opts.json) {
                        const label = step.q ?? step.id ?? step.desc ?? cmd;
                        printStep(String(label), result, msW);
                    }
                    continue;
                }

                const args: string[] = [cmd];
                if (!NO_APP_COMMANDS.has(cmd)) {
                    if (!app) {
                        results.push({ step, result: { ok: false, error: "missing 'app'" }, ms: 0 });
                        continue;
                    }
                    args.push("--app", app);
                }
                if (cmd === "hotkey" && app) {
                    args.push("--app", app);
                }
                for (const [k, v] of Object.entries(step)) {
                    // "_"-prefixed keys are annotations (_label, _foreign), not flags.
                    if (k === "do" || k === "app" || k === "delay" || k === "atMs" || k.startsWith("_") || v == null) {
                        continue;
                    }
                    args.push(`--${k}`, String(v));
                }
                if (plan.exact) {
                    args.push("--exact");
                }

                const t0 = performance.now();
                const result = runAx(args);
                const ms = Math.round(performance.now() - t0);
                results.push({ step, result, ms });

                if (!opts.json) {
                    const label = step.q ?? step.id ?? step.desc ?? step.subrole ?? step.text ?? cmd;
                    printStep(String(label), result, ms);
                }

                if (!timeline) {
                    const stepDelay = typeof step.delay === "number" ? step.delay : delay;
                    if (stepDelay > 0) {
                        Bun.sleepSync(stepDelay);
                    }
                }
            }

            if (plan.restore && snapshot?.ok) {
                runAx(["restore", "--snapshot", SafeJSON.stringify(snapshot)]);
                if (!opts.json) {
                    out.println(`  ${pc.green("restored")} mouse + focus`);
                }
            }

            const failedSteps = results.filter((r) => !r.result.ok).length;
            if (opts.json) {
                out.println(
                    SafeJSON.stringify(
                        {
                            ok: failedSteps === 0,
                            failedSteps,
                            totalSteps: results.length,
                            mode: timeline ? "timeline" : "sequential",
                            steps: results,
                            restored: !!plan.restore,
                        },
                        null,
                        opts.pretty ? 2 : 0
                    )
                );
            } else {
                const passed = results.length - failedSteps;
                const totalMs = results.reduce((s, r) => s + r.ms, 0);
                out.println(`\n${passed}/${results.length} steps passed, ${totalMs}ms total`);
            }
            if (failedSteps > 0) {
                process.exit(1);
            }
        });
}
