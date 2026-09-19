import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import type { Plan } from "../lib/capture-plan";
import { CaptureRunError, runCapturePlan } from "../lib/capture-runner";
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

// `hittest` asks the window server what is under a SCREEN point; it resolves no
// app, and native ax-tool rejects the --app shape for it.
const NO_APP_COMMANDS = new Set(["snapshot", "restore", "hotkey", "apps", "hittest"]);

/**
 * Steps whose failure is transient and happens BEFORE anything is dispatched —
 * the only ones `retries` may wrap.
 *
 * A mutating verb must never retry: `type` can post its keystrokes and then fail
 * its hard verification, so a retry types the text a second time. Same shape for
 * click, set, press and the rest.
 */
const RETRYABLE_STEP_COMMANDS = new Set([
    "get",
    "find",
    "attrs",
    "actions",
    "window",
    "screenshot",
    "ocr",
    "dump",
    "typography",
    "hittest",
    "apps",
    "wait",
    "assert",
]);

/** `retries` above this is a typo or an overflow, not an intention. */
const MAX_RETRIES = 10;

/** `Bun.sleep` clamps a huge delay to ~24 days, which reads as a hang. */
const MAX_RETRY_DELAY_MS = 60_000;

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
    // The verb set used to be smaller than the CLI, so a plan could act but
    // never read pixels: it had to shell out after the runner had already
    // exited, by which time the UI had moved on. These three exist in native
    // ax-tool and dispatch correctly.
    //
    // `draw` and `compare-screenshot` are deliberately NOT here. They are
    // TypeScript-only commands (commands/draw.ts, commands/compare-screenshot.ts);
    // native ax-tool has no such subcommand, so a plan step naming one would
    // reach its `default: errorExit("unknown command")` and fail every time.
    // Accepting them in the plan schema would be a promise the runner cannot
    // keep. Shell out for those two until the runner grows TypeScript dispatch.
    "dump",
    "typography",
    "hittest",
]);

/** Fields the runner consumes itself; everything else becomes a `--flag value`. */
const RUNNER_ONLY_STEP_FIELDS = new Set(["do", "app", "delay", "atMs", "retries", "retryDelayMs", "saveAs"]);

/**
 * `{{steps.2.result.value}}` / `{{saved.total.value}}` resolved against results
 * already collected. A step that needs a value another step READ could not get
 * it before, so "find the id, then press it" meant two runner invocations with
 * a human in the middle.
 *
 * An unresolvable reference is left verbatim on purpose: substituting an empty
 * string would send `--value ""` and look like a successful write of nothing.
 */
export function resolveTemplates(
    value: string,
    results: Array<{ result: AxResult; ms?: number }>,
    saved: Map<string, AxResult>
): { text: string; unresolved: string[] } {
    const unresolved: string[] = [];

    const text = value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
        const parts = expr.split(".");
        let cursor: unknown;

        if (parts[0] === "steps") {
            // The documented form is `{{steps.<n>.result.<field>}}`, so the cursor
            // is the whole ENTRY and `result` is walked like any other segment.
            // Starting at `.result` consumed that segment twice and every
            // reference resolved to undefined.
            const index = Number.parseInt(parts[1] ?? "", 10);
            cursor = Number.isNaN(index) ? undefined : results[index];
            parts.splice(0, 2);
        } else if (parts[0] === "saved") {
            cursor = saved.get(parts[1] ?? "");
            parts.splice(0, 2);
        } else {
            unresolved.push(whole);
            return whole;
        }

        for (const key of parts) {
            if (cursor == null || typeof cursor !== "object") {
                cursor = undefined;
                break;
            }

            cursor = (cursor as Record<string, unknown>)[key];
        }

        if (cursor == null || typeof cursor === "object") {
            unresolved.push(whole);
            return whole;
        }

        return String(cursor);
    });

    return { text, unresolved };
}

/**
 * Everything that can be known about a plan WITHOUT touching the UI. It runs
 * before the first step, because a plan whose step 4 names a verb that does not
 * exist used to change the app twice and then stop halfway.
 */
export function validatePlan(steps: Array<Record<string, unknown>>, planApp: string | undefined): string[] {
    const problems: string[] = [];

    steps.forEach((step, index) => {
        const where = `step ${index + 1}`;

        // A valid JSON plan can hold `null` or an array here. Reading `.do` off
        // one throws inside the preflight, which is the one place that must not.
        if (step === null || typeof step !== "object" || Array.isArray(step)) {
            const what = step === null ? "null" : Array.isArray(step) ? "an array" : typeof step;
            problems.push(`${where}: must be an object, got ${what}`);
            return;
        }

        const raw = String(step.do ?? "");
        const cmd = ACTION_ALIASES[raw] ?? raw;

        if (!raw) {
            problems.push(`${where}: missing 'do'`);
            return;
        }

        if (!KNOWN_STEP_COMMANDS.has(cmd)) {
            problems.push(`${where}: unknown step command '${raw}' — valid: ${[...KNOWN_STEP_COMMANDS].join(", ")}`);
            return;
        }

        if (!NO_APP_COMMANDS.has(cmd) && !step.app && !planApp) {
            problems.push(`${where} (${cmd}): missing 'app', and the plan sets no default`);
        }

        if (step.retries != null) {
            const retries = step.retries;

            // comment-json turns `1e309` into Infinity, which a bare `>= 0`
            // accepts and which makes the retry loop unbounded.
            if (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > MAX_RETRIES) {
                problems.push(`${where} (${cmd}): 'retries' must be a whole number from 0 to ${MAX_RETRIES}`);
            } else if ((retries as number) > 0 && !RETRYABLE_STEP_COMMANDS.has(cmd)) {
                problems.push(
                    `${where} (${cmd}): 'retries' is not allowed on a mutating step — a retry would act twice. ` +
                        `Retryable: ${[...RETRYABLE_STEP_COMMANDS].join(", ")}`
                );
            }
        }

        if (step.retryDelayMs != null) {
            const delay = step.retryDelayMs;

            if (!Number.isFinite(delay) || (delay as number) < 0 || (delay as number) > MAX_RETRY_DELAY_MS) {
                problems.push(`${where} (${cmd}): 'retryDelayMs' must be from 0 to ${MAX_RETRY_DELAY_MS}`);
            }
        }

        if (step.saveAs != null && typeof step.saveAs !== "string") {
            problems.push(`${where} (${cmd}): 'saveAs' must be a string`);
        }
    });

    return problems;
}

interface RunOptions {
    json?: boolean;
    pretty?: boolean;
    plan?: string;
    stopOnFail?: boolean;
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
        .option("--plan <json>", "the plan itself, inline — alternative to a path or to `-`")
        .option("--stop-on-fail", "stop at the first failed step and report the rest as skipped")
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

            const plan = SafeJSON.parse(planText) as {
                app?: string;
                restore?: boolean;
                delayMs?: number;
                exact?: boolean;
                capture?: Record<string, unknown>;
                semantic?: unknown;
                stopOnFail?: boolean;
                actions?: Array<Record<string, unknown>>;
                steps?: Array<Record<string, unknown>>;
            };

            if (plan.semantic !== undefined) {
                throw new Error(
                    "Semantic plans require tools control replay-plan; legacy run cannot ignore their postconditions."
                );
            }
            const steps = plan.steps ?? plan.actions ?? [];

            if (!steps.length) {
                logger.error("plan has no steps");
                process.exit(1);
            }

            // Validation and --dry-run run BEFORE the capture branch. A plan
            // carrying `capture` used to reach runCapturePlan first, so
            // `run --dry-run` on a recording plan drove the real UI — the one
            // thing --dry-run promises never to do.
            const problems = validatePlan(steps, plan.app);

            if (problems.length > 0) {
                if (opts.json) {
                    out.println(SafeJSON.stringify({ ok: false, problems }, null, opts.pretty ? 2 : 0));
                } else {
                    for (const problem of problems) {
                        out.println(`  ${pc.red("INVALID")} ${problem}`);
                    }
                }

                process.exit(1);
            }

            if (opts.dryRun) {
                const planned = steps.map((step, index) => ({
                    index: index + 1,
                    do: ACTION_ALIASES[String(step.do)] ?? String(step.do),
                    app: String(step.app ?? plan.app ?? ""),
                    step,
                }));

                if (opts.json) {
                    out.println(
                        SafeJSON.stringify(
                            { ok: true, dryRun: true, capture: Boolean(plan.capture), steps: planned },
                            null,
                            opts.pretty ? 2 : 0
                        )
                    );
                } else {
                    for (const entry of planned) {
                        out.println(`  ${pc.dim(String(entry.index))} ${pc.cyan(entry.do)} ${pc.dim(entry.app)}`);
                    }

                    out.println(`\n${planned.length} step(s) valid; nothing was run.`);
                }

                process.exit(0);
            }

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
                try {
                    const { captureFailed, ...printable } = await runCapturePlan(normalized as unknown as Plan);
                    out.println(SafeJSON.stringify(printable, null, 2));
                    process.exit(captureFailed ? 1 : 0);
                } catch (e) {
                    if (e instanceof CaptureRunError) {
                        logger.error(e.message);
                        process.exit(e.exitCode);
                    }

                    throw e;
                }
            }

            const timeline = steps.some((s) => typeof s.atMs === "number");
            const delay = plan.delayMs ?? 200;
            let snapshot: AxResult | null = null;

            if (plan.restore) {
                snapshot = runAx(["snapshot"]);
            }

            const startedAt = performance.now();
            const results: Array<{
                step: Record<string, unknown>;
                result: AxResult;
                ms: number;
                attempts?: number;
                skipped?: boolean;
            }> = [];
            const saved = new Map<string, AxResult>();
            const stopOnFail = opts.stopOnFail === true || plan.stopOnFail === true;
            let stoppedAt = -1;

            for (const [index, step] of steps.entries()) {
                if (stoppedAt >= 0) {
                    results.push({
                        step,
                        result: { ok: false, error: "skipped after an earlier failure" },
                        ms: 0,
                        skipped: true,
                    });
                    continue;
                }

                const cmd = ACTION_ALIASES[String(step.do ?? "")] ?? String(step.do ?? "");
                const app = String(step.app ?? plan.app ?? "");

                if (timeline && typeof step.atMs === "number") {
                    const wait = step.atMs - (performance.now() - startedAt);
                    if (wait > 0) {
                        await Bun.sleep(wait);
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
                            ? await waitFor({
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

                    // wait/assert exit the loop body here, so the stop-on-fail
                    // check further down never saw them: a failed condition let
                    // every later step run anyway.
                    if (!result.ok && stopOnFail) {
                        stoppedAt = index;
                    }

                    continue;
                }

                const args: string[] = [cmd];
                if (!NO_APP_COMMANDS.has(cmd)) {
                    args.push("--app", app);
                }
                if (cmd === "hotkey" && app) {
                    args.push("--app", app);
                }

                const unresolved: string[] = [];

                for (const [k, v] of Object.entries(step)) {
                    // "_"-prefixed keys are annotations (_label, _foreign), not flags.
                    if (RUNNER_ONLY_STEP_FIELDS.has(k) || k.startsWith("_") || v == null) {
                        continue;
                    }

                    const raw = String(v);
                    const resolved = raw.includes("{{")
                        ? resolveTemplates(raw, results, saved)
                        : { text: raw, unresolved: [] };
                    unresolved.push(...resolved.unresolved);
                    args.push(`--${k}`, resolved.text);
                }
                if (plan.exact) {
                    args.push("--exact");
                }

                const t0 = performance.now();
                // validatePlan has already refused `retries` on a mutating verb,
                // so this can only repeat a read.
                const maxAttempts = typeof step.retries === "number" ? step.retries + 1 : 1;
                const retryDelay = typeof step.retryDelayMs === "number" ? step.retryDelayMs : 250;
                let result: AxResult;
                let attempts = 0;

                if (unresolved.length > 0) {
                    // Refuse rather than dispatch a half-substituted flag: sending
                    // `--value "{{steps.9.result.value}}"` literally would type the
                    // template into the app and report ok.
                    result = { ok: false, error: `unresolved reference(s): ${unresolved.join(", ")}` };
                    attempts = 1;
                } else {
                    do {
                        attempts++;

                        if (attempts > 1 && retryDelay > 0) {
                            await Bun.sleep(retryDelay);
                        }

                        result = runAx(args);
                    } while (!result.ok && attempts < maxAttempts);
                }

                const ms = Math.round(performance.now() - t0);
                results.push({ step, result, ms, attempts });

                if (typeof step.saveAs === "string") {
                    saved.set(step.saveAs, result);
                }

                if (!opts.json) {
                    const label = step.q ?? step.id ?? step.desc ?? step.subrole ?? step.text ?? cmd;
                    printStep(`${String(label)}${attempts > 1 ? ` (${attempts} attempts)` : ""}`, result, ms);
                }

                if (!result.ok && stopOnFail) {
                    stoppedAt = index;
                    continue;
                }

                if (!timeline) {
                    const stepDelay = typeof step.delay === "number" ? step.delay : delay;
                    if (stepDelay > 0) {
                        await Bun.sleep(stepDelay);
                    }
                }
            }

            if (plan.restore && snapshot?.ok) {
                runAx(["restore", "--snapshot", SafeJSON.stringify(snapshot)]);
                if (!opts.json) {
                    out.println(`  ${pc.green("restored")} mouse + focus`);
                }
            }

            // A skipped step is not a failure: counting it in both failedSteps and
            // skippedSteps reported the same step twice and overstated the damage.
            const failedSteps = results.filter((r) => !r.result.ok && !r.skipped).length;
            if (opts.json) {
                out.println(
                    SafeJSON.stringify(
                        {
                            ok: failedSteps === 0,
                            failedSteps,
                            totalSteps: results.length,
                            mode: timeline ? "timeline" : "sequential",
                            stoppedAtStep: stoppedAt >= 0 ? stoppedAt + 1 : undefined,
                            skippedSteps: stoppedAt >= 0 ? results.length - stoppedAt - 1 : 0,
                            steps: results,
                            restored: !!plan.restore,
                        },
                        null,
                        opts.pretty ? 2 : 0
                    )
                );
            } else {
                // Count what actually succeeded. `length - failedSteps` folded the
                // skipped steps into "passed" once they stopped counting as failed.
                const passed = results.filter((r) => r.result.ok).length;
                const totalMs = results.reduce((s, r) => s + r.ms, 0);
                const skipped = stoppedAt >= 0 ? results.length - stoppedAt - 1 : 0;
                out.println(
                    `\n${passed}/${results.length} steps passed, ${totalMs}ms total${
                        skipped > 0 ? `, ${skipped} skipped after step ${stoppedAt + 1} failed` : ""
                    }`
                );
            }
            if (failedSteps > 0) {
                process.exit(1);
            }
        });
}
