import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { OperationLimits } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { type ExactExpectation, judgeOutcome, resolveIntent } from "./decisions";
import type { ControlDriver } from "./native";
import { observedEvidence } from "./observation";
import { ControlSession } from "./session";

export async function assistTask(options: {
    goal: string;
    expect?: string;
    exact?: ExactExpectation;
    driver: ControlDriver;
    evaluate: Evaluator;
    signal?: AbortSignal;
    limits?: OperationLimits;
}) {
    const goal = z.string().trim().min(1).max(4000).parse(options.goal);
    const session = new ControlSession(options);
    const steps: Array<{
        resolution: Awaited<ReturnType<typeof resolveIntent>>;
        dispatchOk?: boolean;
        observationError?: string;
    }> = [];
    const judgments: Array<Awaited<ReturnType<typeof judgeOutcome>>> = [];
    let status: "verified" | "stopped" | "unknown" = "stopped";
    let reason = "";
    let reobservations = 0;
    const changedToggles = new Set<string>();
    try {
        let observation = await session.observe();
        while (true) {
            const judgment = await judgeOutcome({
                observation,
                expect: options.expect ?? goal,
                exact: options.exact,
                evaluate: session.evaluate,
                signal: session.budget.signal,
            });
            judgments.push(judgment);
            if (judgment.status === "verified") {
                status = "verified";
                reason = "The observed postcondition is verified.";
                break;
            }
            if (judgment.status === "refuted" && judgment.basis === "semantic") {
                reason = "Observed failure contradicts the goal; stopped for inspection.";
                break;
            }
            if (session.budget.actions >= session.budget.limits.maxActions) {
                reason = "Action budget exhausted before the goal was verified.";
                break;
            }
            const resolution = await resolveIntent({
                observation,
                intent: `Task: ${goal}. Choose only the next observed press action that advances this task, or abstain. Do not claim completion by choosing a label.`,
                evaluate: session.evaluate,
                signal: session.budget.signal,
                allowReobserve: true,
            });
            const step: (typeof steps)[number] = { resolution };
            steps.push(step);
            if (resolution.status === "reobserve") {
                if (++reobservations > 1) {
                    reason = "Reobservation budget exhausted.";
                    break;
                }
                await Bun.sleep(Math.min(250, session.budget.remaining()));
                observation = await session.observe();
                continue;
            }
            if (!resolution.selected) {
                reason = "No sufficiently certain permitted next action.";
                break;
            }
            const toggleId = SafeJSON.stringify([
                resolution.selected.identifier,
                resolution.selected.label,
                resolution.selected.ancestors,
            ]);
            if (resolution.selected.checked !== undefined) {
                if (changedToggles.has(toggleId)) {
                    reason = "This toggle was already changed; completion remains unverified. No second toggle.";
                    break;
                }
                changedToggles.add(toggleId);
            }
            const before = SafeJSON.stringify(observedEvidence(observation));
            const dispatched = await session.dispatch({ observation, candidate: resolution.selected });
            step.dispatchOk = dispatched.result.ok;
            step.observationError = dispatched.observationError;
            if (!dispatched.result.ok || !dispatched.after) {
                status = "unknown";
                reason =
                    dispatched.result.error ?? dispatched.observationError ?? "Action outcome is uncertain. No retry.";
                break;
            }
            observation = dispatched.after;
            if (before === SafeJSON.stringify(observedEvidence(observation))) {
                const final = await judgeOutcome({
                    observation,
                    expect: options.expect ?? goal,
                    exact: options.exact,
                    evaluate: session.evaluate,
                    signal: session.budget.signal,
                });
                judgments.push(final);
                status = final.status === "verified" ? "verified" : "stopped";
                reason =
                    final.status === "verified"
                        ? "The observed postcondition is verified."
                        : "No observed change after the action. No repeat was attempted.";
                break;
            }
        }
    } catch (error) {
        logger.debug({ error }, "Bounded control task stopped");
        reason = session.budget.signal.aborted
            ? "Cancelled or deadline reached."
            : error instanceof Error
              ? error.message
              : "Task stopped.";
    }
    return { status, reason, steps, judgments, metrics: session.report() };
}
