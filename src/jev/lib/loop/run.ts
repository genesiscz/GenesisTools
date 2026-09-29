import type { Candidate, Observation } from "@app/control/lib/decision/observation";
import { type ObserveFanout, observeFanout } from "@app/control/lib/decision/observe";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { stripCandidatePrefix } from "./prefix";
import { type CallMeter, MeteredEvaluator, type RunFolder, type StepTiming, summarizeDecision } from "./record";
import { type ScreenSignature, sameScreen, screenOf } from "./screen";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

const prof = profiler.scope("jev-loop");
const { log } = logger.scoped("jev-loop");

const WAIT_SLEEP_MS = 250;
/** Consecutive acts after which the screen is unchanged: a refused press, a dead link, an empty scroll. */
const MAX_IDLE = 3;
/** Consecutive choices of an act already taken on this same screen: a click that does nothing, a cycle. */
const MAX_REPEATS = 2;

export interface GoalLoopStep {
    step: number;
    snapshot: string;
    candidates: number;
    status: ObserveFanout["status"];
    reason: string;
    target: string | null;
    dispatched?: boolean;
    error?: string;
    timing?: StepTiming;
    /** Jev requests this step's decision cost (more than one when the candidates needed a tournament). */
    calls?: number;
}

export interface GoalLoopResult {
    status: "verified" | "stopped";
    reason: string;
    steps: number;
    trace: GoalLoopStep[];
    calls: CallMeter;
    /** The run folder this loop wrote, when it recorded one. */
    runDir?: string;
}

export interface GoalLoopOptions {
    goal: string;
    surface: GoalSurface;
    evaluate: Evaluator;
    maxSteps?: number;
    allowYes?: boolean;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    /** Writes one file per step (inputs, exact requests, answers, decision, timing) for offline replay. */
    record?: RunFolder;
}

/**
 * Every surface row becomes a Candidate Jev can choose, whatever surface it came from. Browser
 * rows have no AX element, so `element` is -1 and the surface's own `act` decides how to click.
 */
export function toCandidates(snapshot: SurfaceSnapshot): Candidate[] {
    return snapshot.candidates.map((row) => ({
        id: row.id,
        element: row.element,
        action: row.action === "chrome" ? "perform" : row.action,
        label: row.label,
        role:
            row.role ??
            (row.action === "click" ? "link_or_button" : row.action === "chrome" ? "chrome_verb" : "AXElement"),
        ancestors: [],
    }));
}

/** A browser-only or merged snapshot still needs an Observation shell for the fan-out contract. */
export function syntheticObservation(snapshot: SurfaceSnapshot): Observation {
    return {
        ok: true,
        app: snapshot.label,
        pid: 0,
        snapshot: snapshot.id,
        window: { id: 0, title: snapshot.label },
        scope: "window",
        elements: [],
    };
}

function evidenceFor(snapshot: SurfaceSnapshot): unknown {
    if (snapshot.evidence !== undefined) {
        return snapshot.evidence;
    }

    if (snapshot.observation) {
        return undefined;
    }

    return snapshot.candidates.map((row) => ({ id: row.id, role: row.role ?? row.action, label: row.label }));
}

export async function runGoalLoop(options: GoalLoopOptions): Promise<GoalLoopResult> {
    const metered = new MeteredEvaluator(options.evaluate);
    const stopLoop = prof.start("loop");
    try {
        const result = await runSteps(options, metered);
        const calls = { ...metered.meter };
        if (options.record) {
            await options.record.finish({ status: result.status, reason: result.reason, steps: result.steps, calls });
        }

        log.info(
            { status: result.status, reason: result.reason, steps: result.steps, calls, runDir: options.record?.dir },
            "goal loop finished"
        );
        return { ...result, calls, ...(options.record ? { runDir: options.record.dir } : {}) };
    } finally {
        stopLoop();
    }
}

async function runSteps(
    options: GoalLoopOptions,
    metered: MeteredEvaluator
): Promise<Omit<GoalLoopResult, "calls" | "runDir">> {
    const maxSteps = options.maxSteps ?? 8;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const trace: GoalLoopStep[] = [];
    // Every act with the screen it was taken on. A wait is never recorded: waiting is repeating by
    // design, and the model must stay free to wait again.
    const taken: Array<{ screen: ScreenSignature; label: string }> = [];
    let beforeAct: ScreenSignature | undefined;
    /** The screen the last act was taken on; a later read that differs from it is progress. */
    let lastActScreen: ScreenSignature | undefined;
    let idle = 0;
    let repeats = 0;
    log.info({ goal: options.goal, surface: options.surface.kind, maxSteps }, "goal loop starting");
    for (let step = 0; step < maxSteps; step++) {
        options.signal?.throwIfAborted();
        const seeClock = new Stopwatch();
        const snapshot = await prof.measureAsync("see", () => options.surface.see(options.signal));
        const seeMs = Math.round(seeClock.elapsedMs);
        const screen = screenOf(snapshot);
        if (beforeAct) {
            idle = sameScreen(beforeAct, screen) ? idle + 1 : 0;
            beforeAct = undefined;
            if (idle >= MAX_IDLE) {
                log.warn({ step, idle }, "goal loop stalled: the last acts changed nothing on screen");
                return { status: "stopped", reason: "stalled", steps: step, trace };
            }
        } else if (idle > 0 && lastActScreen && !sameScreen(lastActScreen, screen)) {
            // A slow app: the act landed while we waited, so it was progress after all.
            idle = 0;
        }

        const triedHere = [
            ...new Set(taken.filter((entry) => sameScreen(entry.screen, screen)).map((entry) => entry.label)),
        ];
        const candidates = toCandidates(snapshot);
        log.debug(
            { step, snapshot: snapshot.id.slice(0, 24), candidates: candidates.length, surface: options.surface.kind },
            "goal loop see"
        );
        // A screen with nothing to press is still asked: a receipt or a finished progress window is
        // where the goal is done, and a loading page is where to wait. The fan-out then offers
        // abstain alone.
        // Jev decides on EVERY step, for every surface. Before this rewrite a browser-only snapshot
        // acted on `candidates[0]` blind, and merged `cdp:` rows were never choosable because the
        // fan-out saw the AX observation alone.
        const input = {
            goal: options.goal,
            observation: snapshot.observation ?? syntheticObservation(snapshot),
            candidates,
            evidence: evidenceFor(snapshot),
            triedHere,
            allowYes: options.allowYes === true,
        };
        metered.drain();
        const decideClock = new Stopwatch();
        const fanout = await prof.measureAsync("fanout", () =>
            observeFanout({ ...input, evaluate: metered.evaluate, signal: options.signal })
        );
        const calls = metered.drain();
        const row: GoalLoopStep = {
            step,
            snapshot: snapshot.id,
            candidates: candidates.length,
            status: fanout.status,
            reason: fanout.reason,
            target: fanout.target?.id ?? null,
            timing: { seeMs, decideMs: Math.round(decideClock.elapsedMs) },
            calls: calls.length,
        };
        trace.push(row);
        const recordStep = (act?: { target: string; ok: boolean; error?: string }) => {
            options.record?.writeStep({
                step,
                snapshot: { id: snapshot.id, label: snapshot.label },
                input,
                calls,
                decision: summarizeDecision(fanout),
                ...(act ? { act } : {}),
                timing: row.timing ?? { seeMs, decideMs: 0 },
            });
        };
        log.info(
            { step, status: fanout.status, reason: fanout.reason, target: row.target, done: fanout.done },
            "goal loop decision"
        );
        if (fanout.status === "verified") {
            recordStep();
            return { status: "verified", reason: fanout.reason, steps: step, trace };
        }

        if (fanout.status === "wait") {
            recordStep();
            await sleep(WAIT_SLEEP_MS);
            continue;
        }

        if (fanout.status !== "act" || !fanout.target) {
            const reason = candidates.length === 0 ? "no_candidates" : fanout.reason;
            row.reason = reason;
            recordStep();
            return { status: "stopped", reason, steps: step, trace };
        }

        const candidate = findSurfaceCandidate(snapshot, fanout.target.id);
        if (!candidate) {
            row.reason = "missing_candidate";
            recordStep();
            return { status: "stopped", reason: "missing_candidate", steps: step, trace };
        }

        repeats = triedHere.includes(candidate.label) ? repeats + 1 : 0;
        if (repeats >= MAX_REPEATS) {
            row.reason = "repeating";
            recordStep();
            log.warn({ step, target: candidate.label, repeats }, "goal loop stopped a repeated act on this screen");
            return { status: "stopped", reason: "repeating", steps: step, trace };
        }

        const actClock = new Stopwatch();
        const acted = await prof.measureAsync("act", () => options.surface.act(snapshot, candidate));
        row.dispatched = acted.ok;
        row.error = acted.error;
        row.timing = { seeMs, decideMs: row.timing?.decideMs ?? 0, actMs: Math.round(actClock.elapsedMs) };
        recordStep({ target: candidate.id, ok: acted.ok, ...(acted.error ? { error: acted.error } : {}) });
        log.info({ step, target: candidate.id, ok: acted.ok, error: acted.error }, "goal loop act");
        if (!acted.ok) {
            return { status: "stopped", reason: acted.error ?? "act_failed", steps: step + 1, trace };
        }

        taken.push({ screen, label: candidate.label });
        beforeAct = screen;
        lastActScreen = screen;
    }

    return { status: "stopped", reason: "step_budget", steps: maxSteps, trace };
}

function findSurfaceCandidate(snapshot: SurfaceSnapshot, targetId: string): SurfaceCandidate | undefined {
    return snapshot.candidates.find((item) => item.id === targetId || stripCandidatePrefix(item.id).id === targetId);
}

/** One line per step: what it cost in wall time and Jev calls. Ported from typesafe-computer-use `timing.py`. */
export function stepTimingLine(step: GoalLoopStep): string {
    const timing = step.timing;
    if (!timing) {
        return "";
    }

    const parts = [
        `see ${timing.seeMs} ms`,
        `jev ${timing.decideMs} ms (${step.calls ?? 0} call${step.calls === 1 ? "" : "s"})`,
    ];
    if (timing.actMs !== undefined) {
        parts.push(`act ${timing.actMs} ms`);
    }

    return parts.join(" · ");
}

/** The run's classifier cost in one line: calls, wall time and tokens. Ported from typesafe-computer-use `calls.py`. */
export function callsLine(calls: CallMeter): string {
    const failures = calls.failures > 0 ? `, ${calls.failures} failed` : "";
    return `jev ${calls.calls} call${calls.calls === 1 ? "" : "s"}${failures} · ${(calls.ms / 1000).toFixed(1)} s · ${calls.inputTokens.toLocaleString("en-US")} in / ${calls.outputTokens.toLocaleString("en-US")} out tokens`;
}
