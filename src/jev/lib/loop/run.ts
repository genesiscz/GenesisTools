import type { Candidate, Observation } from "@app/control/lib/decision/observation";
import { type ObserveFanout, observeFanout } from "@app/control/lib/decision/observe";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { stripCandidatePrefix } from "./prefix";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

const prof = profiler.scope("jev-loop");
const { log } = logger.scoped("jev-loop");

const WAIT_SLEEP_MS = 250;

export interface GoalLoopStep {
    step: number;
    snapshot: string;
    candidates: number;
    status: ObserveFanout["status"];
    reason: string;
    target: string | null;
    dispatched?: boolean;
    error?: string;
}

export interface GoalLoopResult {
    status: "verified" | "stopped";
    reason: string;
    steps: number;
    trace: GoalLoopStep[];
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

export async function runGoalLoop(options: {
    goal: string;
    surface: GoalSurface;
    evaluate: Evaluator;
    maxSteps?: number;
    allowYes?: boolean;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
}): Promise<GoalLoopResult> {
    const maxSteps = options.maxSteps ?? 8;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const trace: GoalLoopStep[] = [];
    const stopLoop = prof.start("loop");
    log.info({ goal: options.goal, surface: options.surface.kind, maxSteps }, "goal loop starting");
    try {
        for (let step = 0; step < maxSteps; step++) {
            options.signal?.throwIfAborted();
            const snapshot = await prof.measureAsync("see", () => options.surface.see(options.signal));
            const candidates = toCandidates(snapshot);
            log.debug(
                {
                    step,
                    snapshot: snapshot.id.slice(0, 24),
                    candidates: candidates.length,
                    surface: options.surface.kind,
                },
                "goal loop see"
            );
            if (candidates.length === 0) {
                trace.push({
                    step,
                    snapshot: snapshot.id,
                    candidates: 0,
                    status: "abstained",
                    reason: "no_candidates",
                    target: null,
                });
                return { status: "stopped", reason: "no_candidates", steps: step, trace };
            }

            // Jev decides on EVERY step, for every surface. Before this rewrite a browser-only
            // snapshot acted on `candidates[0]` blind, and merged `cdp:` rows were never choosable
            // because the fan-out saw the AX observation alone.
            const fanout = await prof.measureAsync("fanout", () =>
                observeFanout({
                    observation: snapshot.observation ?? syntheticObservation(snapshot),
                    candidates,
                    evidence: evidenceFor(snapshot),
                    goal: options.goal,
                    evaluate: options.evaluate,
                    signal: options.signal,
                    allowYes: options.allowYes,
                })
            );
            const row: GoalLoopStep = {
                step,
                snapshot: snapshot.id,
                candidates: candidates.length,
                status: fanout.status,
                reason: fanout.reason,
                target: fanout.target?.id ?? null,
            };
            trace.push(row);
            log.info(
                { step, status: fanout.status, reason: fanout.reason, target: row.target, done: fanout.done },
                "goal loop decision"
            );
            if (fanout.status === "verified") {
                return { status: "verified", reason: fanout.reason, steps: step, trace };
            }

            if (fanout.status === "wait") {
                await sleep(WAIT_SLEEP_MS);
                continue;
            }

            if (fanout.status !== "act" || !fanout.target) {
                return { status: "stopped", reason: fanout.reason, steps: step, trace };
            }

            const candidate = findSurfaceCandidate(snapshot, fanout.target.id);
            if (!candidate) {
                row.reason = "missing_candidate";
                return { status: "stopped", reason: "missing_candidate", steps: step, trace };
            }

            const acted = await prof.measureAsync("act", () => options.surface.act(snapshot, candidate));
            row.dispatched = acted.ok;
            row.error = acted.error;
            log.info({ step, target: candidate.id, ok: acted.ok, error: acted.error }, "goal loop act");
            if (!acted.ok) {
                return { status: "stopped", reason: acted.error ?? "act_failed", steps: step + 1, trace };
            }
        }

        return { status: "stopped", reason: "step_budget", steps: maxSteps, trace };
    } finally {
        stopLoop();
    }
}

function findSurfaceCandidate(snapshot: SurfaceSnapshot, targetId: string): SurfaceCandidate | undefined {
    return snapshot.candidates.find((item) => item.id === targetId || stripCandidatePrefix(item.id).id === targetId);
}
