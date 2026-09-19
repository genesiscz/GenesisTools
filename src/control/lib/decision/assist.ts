import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { OperationLimits } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { type ChooserMode, chooseCandidate, type HostDecision } from "./chooser";
import { type ExactExpectation, judgeOutcome } from "./decisions";
import type { ControlDriver } from "./native";
import { observedRows } from "./observation";
import { type ObserveFanout, observeFanout } from "./observe";
import { actionRefusal, authenticationBarrier, RecoveryController, type RecoveryOptions } from "./recovery";
import { ControlSession } from "./session";

const { log } = logger.scoped("control-assist");

export async function assistTask(options: {
    goal: string;
    expect?: string;
    exact?: ExactExpectation;
    driver: ControlDriver;
    evaluate: Evaluator;
    signal?: AbortSignal;
    limits?: OperationLimits;
    recovery?: RecoveryOptions;
    chooser?: ChooserMode;
    hostDecision?: HostDecision;
    fanout?: boolean;
}) {
    const goal = z.string().trim().min(1).max(4000).parse(options.goal);
    const session = new ControlSession(options);
    const recovery = new RecoveryController(options.recovery);
    if (options.chooser === "exact" && (!options.exact || recovery.options.mode !== "off")) {
        throw new Error(
            "Exact-only assist requires exact completion readback and recovery off; semantic judgment/recovery requires Jev."
        );
    }
    const steps: Array<{
        /** Serial chooser result; absent on fan-out steps. */
        resolution?: Awaited<ReturnType<typeof chooseCandidate>>;
        /** Fan-out result; absent on serial steps. */
        fanout?: ObserveFanout;
        dispatchOk?: boolean;
        refusal?: ReturnType<typeof actionRefusal>;
        observationError?: string;
    }> = [];
    const judgments: Array<Awaited<ReturnType<typeof judgeOutcome>>> = [];
    let status: "verified" | "stopped" | "unknown" = "stopped";
    let reason = "";
    let reobservations = 0;
    let lastRefusal: ReturnType<typeof actionRefusal> | undefined;
    const changedToggles = new Set<string>();
    let hostDecision = options.hostDecision;
    try {
        let observation = await session.observe();
        while (true) {
            if (recovery.options.mode === "bounded" && authenticationBarrier(observation)) {
                reason = "Authentication or permission UI requires user input.";
                break;
            }
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
            if (options.fanout) {
                const fanout = await observeFanout({
                    observation,
                    goal,
                    exact: options.exact,
                    evaluate: session.evaluate,
                    signal: session.budget.signal,
                    lastRefusal,
                    remedies: recovery.options.remedies,
                });
                if (fanout.status === "verified") {
                    status = "verified";
                    reason = fanout.reason;
                    break;
                }

                if (fanout.status === "wait") {
                    log.info({ step: steps.length, wait: fanout.wait }, "assist: fan-out says wait; re-observing");
                    await Bun.sleep(Math.min(250, session.budget.remaining()));
                    observation = await session.observe();
                    continue;
                }

                if (fanout.status !== "act" || !fanout.target) {
                    if (fanout.status === "abstained") {
                        log.info(
                            { step: steps.length, reason: fanout.reason },
                            "assist: fan-out abstained; trying recovery"
                        );
                        const fresh = await recovery.recover({
                            session,
                            category: "semantic_interruption",
                            observation,
                            goal,
                        });
                        if (fresh) {
                            observation = fresh;
                            continue;
                        }
                    }

                    log.info(
                        { step: steps.length, status: fanout.status, reason: fanout.reason },
                        "assist: stopping on fan-out"
                    );
                    reason = fanout.reason;
                    break;
                }

                // The three guards the serial branch has always had apply here too: never toggle a
                // checkbox twice while completion is unverified, recover from a refusal through the
                // bounded controller, and stop when an action changed nothing observable.
                const fanoutToggleId = SafeJSON.stringify([
                    fanout.target.identifier,
                    fanout.target.label,
                    fanout.target.ancestors,
                ]);
                if (fanout.target.checked !== undefined && changedToggles.has(fanoutToggleId)) {
                    log.warn(
                        { step: steps.length, target: fanout.target.label },
                        "assist: double-toggle guard stopped a second toggle"
                    );
                    reason = "This toggle was already changed; completion remains unverified. No second toggle.";
                    break;
                }

                const beforeEvidence = SafeJSON.stringify(observedRows(observation));
                const dispatched = await session.dispatch({ observation, candidate: fanout.target });
                const fanoutStep: (typeof steps)[number] = {
                    fanout,
                    dispatchOk: dispatched.result.ok,
                    observationError: dispatched.observationError,
                    refusal: dispatched.result.ok ? undefined : actionRefusal(dispatched.result),
                };
                steps.push(fanoutStep);
                if (fanout.target.checked !== undefined && dispatched.result.dispatchState !== "not_started") {
                    changedToggles.add(fanoutToggleId);
                }

                if (!dispatched.result.ok) {
                    lastRefusal = actionRefusal(dispatched.result);
                    log.warn(
                        { step: steps.length, refusal: lastRefusal, error: dispatched.result.error },
                        "assist: dispatch refused; trying recovery"
                    );
                    const fresh = await recovery.recover({
                        session,
                        category: lastRefusal,
                        observation: dispatched.after,
                        goal,
                    });
                    if (fresh) {
                        observation = fresh;
                        continue;
                    }

                    status = "unknown";
                    reason = dispatched.result.error ?? dispatched.observationError ?? "Action outcome is uncertain.";
                    break;
                }

                lastRefusal = undefined;
                if (!dispatched.after) {
                    status = "unknown";
                    reason = dispatched.observationError ?? "Action outcome is uncertain.";
                    break;
                }

                observation = dispatched.after;
                if (beforeEvidence === SafeJSON.stringify(observedRows(observation))) {
                    log.info(
                        { step: steps.length, target: fanout.target.label },
                        "assist: no observable change after the act; asking the final judge instead of repeating"
                    );
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

                continue;
            }

            const resolution = await chooseCandidate({
                observation,
                intent: goal,
                mode: options.chooser ?? "jev",
                session,
                hostDecision,
                signal: session.budget.signal,
                allowReobserve: true,
            });
            const step: (typeof steps)[number] = { resolution };
            steps.push(step);
            if (resolution.source === "host") {
                hostDecision = undefined;
            }
            if (resolution.status === "reobserve") {
                if (++reobservations > 1) {
                    reason = "Reobservation budget exhausted.";
                    break;
                }
                await Bun.sleep(Math.min(250, session.budget.remaining()));
                observation = await session.observe();
                continue;
            }
            if (resolution.status === "escalated") {
                reason = resolution.reason;
                break;
            }
            if (!resolution.selected) {
                const fresh = await recovery.recover({ session, category: "semantic_interruption", observation, goal });
                if (fresh) {
                    observation = fresh;
                    continue;
                }
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
                    log.warn(
                        { step: steps.length, target: resolution.selected.label },
                        "assist: double-toggle guard stopped a second toggle"
                    );
                    reason = "This toggle was already changed; completion remains unverified. No second toggle.";
                    break;
                }
            }
            const before = SafeJSON.stringify(observedRows(observation));
            const dispatched = await session.dispatch({ observation, candidate: resolution.selected });
            step.dispatchOk = dispatched.result.ok;
            step.observationError = dispatched.observationError;
            if (resolution.selected.checked !== undefined && dispatched.result.dispatchState !== "not_started") {
                changedToggles.add(toggleId);
            }
            if (!dispatched.result.ok) {
                step.refusal = actionRefusal(dispatched.result);
                log.warn(
                    { step: steps.length, refusal: step.refusal, error: dispatched.result.error },
                    "assist: dispatch refused; trying recovery"
                );
                const fresh = await recovery.recover({
                    session,
                    category: step.refusal,
                    observation: dispatched.after,
                    goal,
                });
                if (fresh) {
                    observation = fresh;
                    continue;
                }
            }
            if (!dispatched.result.ok || !dispatched.after) {
                status = "unknown";
                reason =
                    dispatched.result.error ?? dispatched.observationError ?? "Action outcome is uncertain. No retry.";
                break;
            }
            observation = dispatched.after;
            if (before === SafeJSON.stringify(observedRows(observation))) {
                log.info(
                    { step: steps.length, target: resolution.selected.label },
                    "assist: no observable change after the act; asking the final judge instead of repeating"
                );
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
    const metrics = session.report();
    log.info(
        {
            status,
            reason,
            steps: steps.length,
            judgments: judgments.length,
            recoveries: recovery.attempts.length,
            fanout: options.fanout === true,
            metrics,
        },
        "assist finished"
    );
    return { status, reason, steps, judgments, recoveries: recovery.attempts, metrics };
}
