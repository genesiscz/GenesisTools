import { SafeJSON } from "@genesiscz/utils/json";
import type { Plan } from "./capture-plan";
import { type RunResult, runCapturePlan } from "./capture-runner";
import { assertEl, waitFor } from "./conditions";
import { guardFocusSteal, isFocusStealingVerb } from "./focus-guard";
import { type AxResult, type AxRun, runAx } from "./runner";

/**
 * The declarative plan runner behind `control run`, the `control_run` MCP tool and any later door.
 * Every behaviour lives here; the doors parse input and render the report.
 */

export const ACTION_ALIASES: Record<string, string> = {
    "ax-set": "set",
    "ax-press": "press",
    "ax-perform": "perform",
    axSet: "set",
    axPress: "press",
    axPerform: "perform",
};

// `hittest` asks the window server what is under a SCREEN point; it resolves no
// app, and native ax-tool rejects the --app shape for it.
export const NO_APP_COMMANDS = new Set(["snapshot", "restore", "hotkey", "apps", "hittest"]);

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

export const KNOWN_STEP_COMMANDS = new Set([
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

/** The plan document every door accepts: `steps` (or the older `actions`) plus plan-level defaults. */
export interface PlanDocument {
    app?: string;
    restore?: boolean;
    delayMs?: number;
    exact?: boolean;
    capture?: Record<string, unknown>;
    semantic?: unknown;
    stopOnFail?: boolean;
    actions?: Array<Record<string, unknown>>;
    steps?: Array<Record<string, unknown>>;
}

export interface PlanStepResult {
    step: Record<string, unknown>;
    result: AxResult;
    ms: number;
    attempts?: number;
    skipped?: boolean;
}

/** The report of a sequential or timeline run: the shape `control run --json` has always printed. */
export interface PlanRunReport {
    ok: boolean;
    failedSteps: number;
    totalSteps: number;
    mode: "timeline" | "sequential";
    stoppedAtStep?: number;
    skippedSteps: number;
    steps: PlanStepResult[];
    restored: boolean;
}

export interface PlannedStep {
    index: number;
    do: string;
    app: string;
    step: Record<string, unknown>;
}

/** What one execution produced; each door renders its own branch. */
export type PlanOutcome =
    | { kind: "invalid"; problems: string[] }
    | { kind: "dry-run"; capture: boolean; steps: PlannedStep[] }
    | { kind: "capture"; result: Omit<RunResult, "captureFailed">; captureFailed: boolean }
    | { kind: "ran"; report: PlanRunReport };

/** Everything that reaches the machine, injectable so the runner is testable without a Mac in any state. */
export interface PlanRunDeps {
    run: AxRun;
    waitFor: typeof waitFor;
    assertEl: typeof assertEl;
    guard: typeof guardFocusSteal;
    capture: (plan: Plan) => Promise<RunResult>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}

export const DEFAULT_PLAN_RUN_DEPS: PlanRunDeps = {
    run: runAx,
    waitFor,
    assertEl,
    guard: guardFocusSteal,
    capture: runCapturePlan,
    sleep: (ms) => Bun.sleep(ms),
    now: () => performance.now(),
};

/** A plan given as text (a file, stdin, `--plan`, an MCP string) must be a JSON object. */
export function parsePlanDocument(value: unknown): PlanDocument {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error('a plan must be a JSON object like {"app":"…","steps":[…]}');
    }

    return value as PlanDocument;
}

export function stepCommand(step: Record<string, unknown>): string {
    const raw = String(step.do ?? "");
    return ACTION_ALIASES[raw] ?? raw;
}

/** The label a human report prints for one step. */
export function stepLabel(step: Record<string, unknown>): string {
    return String(step.q ?? step.id ?? step.desc ?? step.subrole ?? step.text ?? stepCommand(step));
}

/**
 * Recording plans: the capture runner owns the whole timeline. Normalize BEFORE delegating: the
 * runner reads `actions` with its own ax-prefixed verbs and axId targeting; the unified schema
 * promises `steps` + plain verbs + `id` work here too.
 */
export function normalizeCapturePlan(plan: PlanDocument): Plan {
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

    return normalized as unknown as Plan;
}

async function runConditionStep({
    cmd,
    step,
    app,
    deps,
}: {
    cmd: "wait" | "assert";
    step: Record<string, unknown>;
    app: string;
    deps: PlanRunDeps;
}): Promise<AxResult> {
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
        for: typeof step.for === "string" ? step.for : undefined,
        value: typeof step.expect === "string" ? step.expect : undefined,
        contains: typeof step.contains === "string" ? step.contains : undefined,
        run: deps.run,
    };

    if (cmd === "assert") {
        return deps.assertEl(cond);
    }

    return deps.waitFor({
        ...cond,
        timeout: typeof step.timeout === "number" ? step.timeout : 5000,
        interval: typeof step.interval === "number" ? step.interval : 200,
    });
}

/**
 * Validate, then dry-run, record or run a plan. Validation and `dryRun` come BEFORE the capture
 * branch: a plan carrying `capture` used to reach the recorder first, so a dry run on a recording
 * plan drove the real UI, the one thing a dry run promises never to do.
 */
export async function executePlan({
    plan,
    stopOnFail: stopOnFailFlag,
    stealFocus,
    dryRun,
    onStep,
    deps = DEFAULT_PLAN_RUN_DEPS,
}: {
    plan: PlanDocument;
    stopOnFail?: boolean;
    stealFocus?: boolean;
    dryRun?: boolean;
    onStep?: (entry: PlanStepResult) => void;
    deps?: PlanRunDeps;
}): Promise<PlanOutcome> {
    if (plan.semantic !== undefined) {
        throw new Error(
            "Semantic plans need the workflow runner (control replay-plan or control workflow run); the legacy runner cannot ignore their postconditions."
        );
    }

    const steps = plan.steps ?? plan.actions ?? [];

    if (!steps.length) {
        return { kind: "invalid", problems: ["plan has no steps"] };
    }

    const problems = validatePlan(steps, plan.app);

    if (problems.length > 0) {
        return { kind: "invalid", problems };
    }

    if (dryRun) {
        return {
            kind: "dry-run",
            capture: Boolean(plan.capture),
            steps: steps.map((step, index) => ({
                index: index + 1,
                do: stepCommand(step),
                app: String(step.app ?? plan.app ?? ""),
                step,
            })),
        };
    }

    if (plan.capture) {
        const { captureFailed, ...result } = await deps.capture(normalizeCapturePlan(plan));
        return { kind: "capture", result, captureFailed };
    }

    return {
        kind: "ran",
        report: await runSteps({ plan, steps, stopOnFail: stopOnFailFlag, stealFocus, onStep, deps }),
    };
}

async function runSteps({
    plan,
    steps,
    stopOnFail: stopOnFailFlag,
    stealFocus,
    onStep,
    deps,
}: {
    plan: PlanDocument;
    steps: Array<Record<string, unknown>>;
    stopOnFail?: boolean;
    stealFocus?: boolean;
    onStep?: (entry: PlanStepResult) => void;
    deps: PlanRunDeps;
}): Promise<PlanRunReport> {
    const timeline = steps.some((s) => typeof s.atMs === "number");
    const delay = plan.delayMs ?? 200;
    const snapshot: AxResult | null = plan.restore ? await deps.run(["snapshot"]) : null;
    const startedAt = deps.now();
    const results: PlanStepResult[] = [];
    const saved = new Map<string, AxResult>();
    const stopOnFail = stopOnFailFlag === true || plan.stopOnFail === true;
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

        const cmd = stepCommand(step);
        const app = String(step.app ?? plan.app ?? "");

        if (timeline && typeof step.atMs === "number") {
            const wait = step.atMs - (deps.now() - startedAt);
            if (wait > 0) {
                await deps.sleep(wait);
            }
        }

        // wait/assert are TS-side condition steps, not binary commands. They leave the loop body
        // here, so the stop-on-fail check is theirs too: once it sat further down, and a failed
        // condition let every later step run anyway.
        if (cmd === "wait" || cmd === "assert") {
            const t0w = deps.now();
            const result = await runConditionStep({ cmd, step, app, deps });
            const entry = { step, result, ms: Math.round(deps.now() - t0w) };
            results.push(entry);
            onStep?.(entry);

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
            const resolved = raw.includes("{{") ? resolveTemplates(raw, results, saved) : { text: raw, unresolved: [] };
            unresolved.push(...resolved.unresolved);
            args.push(`--${k}`, resolved.text);
        }

        if (plan.exact) {
            args.push("--exact");
        }

        const t0 = deps.now();
        // validatePlan has already refused `retries` on a mutating verb, so this can only repeat a read.
        const maxAttempts = typeof step.retries === "number" ? step.retries + 1 : 1;
        const retryDelay = typeof step.retryDelayMs === "number" ? step.retryDelayMs : 250;
        let result: AxResult;
        let attempts = 0;
        const refusal = isFocusStealingVerb(cmd)
            ? await deps.guard({
                  verb: cmd,
                  app: app || undefined,
                  toPid: step["to-pid"] == null ? undefined : String(step["to-pid"]),
                  stealFocus,
                  run: deps.run,
              })
            : null;

        if (refusal !== null) {
            result = refusal;
            attempts = 1;
        } else if (unresolved.length > 0) {
            // Refuse rather than dispatch a half-substituted flag: sending
            // `--value "{{steps.9.result.value}}"` literally would type the template into the app and report ok.
            result = { ok: false, error: `unresolved reference(s): ${unresolved.join(", ")}` };
            attempts = 1;
        } else {
            do {
                attempts++;

                if (attempts > 1 && retryDelay > 0) {
                    await deps.sleep(retryDelay);
                }

                result = await deps.run(args);
            } while (!result.ok && attempts < maxAttempts);
        }

        const entry = { step, result, ms: Math.round(deps.now() - t0), attempts };
        results.push(entry);
        onStep?.(entry);

        if (typeof step.saveAs === "string") {
            saved.set(step.saveAs, result);
        }

        if (!result.ok && stopOnFail) {
            stoppedAt = index;
            continue;
        }

        if (!timeline) {
            const stepDelay = typeof step.delay === "number" ? step.delay : delay;
            if (stepDelay > 0) {
                await deps.sleep(stepDelay);
            }
        }
    }

    if (plan.restore && snapshot?.ok) {
        await deps.run(["restore", "--snapshot", SafeJSON.stringify(snapshot)]);
    }

    // A skipped step is not a failure: counting it in both failedSteps and skippedSteps reported
    // the same step twice and overstated the damage.
    const failedSteps = results.filter((r) => !r.result.ok && !r.skipped).length;
    return {
        ok: failedSteps === 0,
        failedSteps,
        totalSteps: results.length,
        mode: timeline ? "timeline" : "sequential",
        stoppedAtStep: stoppedAt >= 0 ? stoppedAt + 1 : undefined,
        skippedSteps: stoppedAt >= 0 ? results.length - stoppedAt - 1 : 0,
        steps: results,
        restored: !!plan.restore,
    };
}
