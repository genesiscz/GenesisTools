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
        // The screen as it was before the most recent act. The judge needs it to tell an outcome
        // that happened from a label that was already there; see rowsChanged in decisions.ts.
        let beforeAct: typeof observation | undefined;
        /** The label of the last thing acted on, for the repeated-target guard below. */
        let lastActed: ActedTarget | undefined;
        while (true) {
            if (recovery.options.mode === "bounded" && authenticationBarrier(observation)) {
                reason = "Authentication or permission UI requires user input.";
                break;
            }
            const judgment = await judgeOutcome({
                observation,
                before: beforeAct,
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

                if (namesTheSameThing(lastActed, fanout.target)) {
                    log.warn(
                        { step: steps.length, target: fanout.target.label, previous: lastActed?.label },
                        "assist: repeated-target guard stopped a second act on the same thing"
                    );
                    reason = repeatedTargetReason(fanout.target.label);
                    break;
                }

                const beforeEvidence = SafeJSON.stringify(observedRows(observation));
                beforeAct = observation;
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

                // Only a dispatch that landed makes a second act on the same thing a repeat.
                // A refusal is retried on purpose by the bounded recovery controller.
                lastActed = fanout.target;
                observation = dispatched.after;
                if (beforeEvidence === SafeJSON.stringify(observedRows(observation))) {
                    log.info(
                        { step: steps.length, target: fanout.target.label },
                        "assist: no observable change after the act; asking the final judge instead of repeating"
                    );
                    const final = await judgeOutcome({
                        observation,
                        before: beforeAct,
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
            if (namesTheSameThing(lastActed, resolution.selected)) {
                log.warn(
                    { step: steps.length, target: resolution.selected.label, previous: lastActed?.label },
                    "assist: repeated-target guard stopped a second act on the same thing"
                );
                reason = repeatedTargetReason(resolution.selected.label);
                break;
            }

            const before = SafeJSON.stringify(observedRows(observation));
            beforeAct = observation;
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
            // Only a dispatch that landed makes a second act on the same thing a repeat.
            // A refusal is retried on purpose by the bounded recovery controller.
            lastActed = resolution.selected;
            observation = dispatched.after;
            if (before === SafeJSON.stringify(observedRows(observation))) {
                log.info(
                    { step: steps.length, target: resolution.selected.label },
                    "assist: no observable change after the act; asking the final judge instead of repeating"
                );
                const final = await judgeOutcome({
                    observation,
                    before: beforeAct,
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

/**
 * Do two labels name the same thing?
 *
 * A row's label changes shape as the screen does. A conversation is "+1 (888) 555-1212,
 * 01.01.2001" in the list and "+1 (888) 555-1212" once it is open, so a loop that could not tell
 * them apart opened the conversation and then tapped its title, landing in contact details: one
 * unwanted act past the goal.
 *
 * The rule is deliberately narrow: the two are the same thing when they are equal after dropping a
 * trailing comma-separated segment that carries NO letters. A date, a time or a count is
 * decoration a list adds; a word is not. That keeps "Camera" and "Camera Roll" as two targets, and
 * "OK" and "OK, continue" as two targets, which a plain containment test got wrong.
 *
 * A false positive only stops the loop and asks the judge, so erring narrow costs at most one
 * unwanted act; erring wide would stop real two-step tasks.
 */
export interface ActedTarget {
    targetKey?: string;
    label: string;
}

/**
 * Identity first, label only as a fallback.
 *
 * `targetKey` is the semantic row identity ax-tool computes from the parent branch, so two rows
 * with the same text in different places are different keys. Comparing labels alone blocked a
 * DISTINCT control that merely reused a word: a second "Continue" after navigation is a new
 * button, and refusing it stopped a legitimate two-step task. When neither side carries a key
 * the label rule below still applies, because that is all there is to compare.
 */
export function namesTheSameThing(previous: ActedTarget | undefined, next: ActedTarget): boolean {
    if (previous === undefined) {
        return false;
    }

    if (previous.targetKey !== undefined && next.targetKey !== undefined) {
        return previous.targetKey === next.targetKey;
    }

    const a = withoutDecoration(previous.label);
    const b = withoutDecoration(next.label);
    return a.length > 0 && a === b;
}

function withoutDecoration(label: string): string {
    const normalised = label.toLowerCase().replace(/\s+/g, " ").trim();
    const comma = normalised.lastIndexOf(",");
    if (comma === -1) {
        return normalised;
    }

    // Any script's letters, not just ASCII. With /[a-z]/ a localised label like "设置, 高级" had
    // no letters in its tail, so the trailing clause read as decoration and the guard refused a
    // genuinely different second target on every non-Latin UI.
    const tail = normalised.slice(comma + 1);
    return /\p{L}/u.test(tail) ? normalised : normalised.slice(0, comma).trim();
}

function repeatedTargetReason(label: string): string {
    return `The previous act already targeted ${label.slice(0, 80)}; completion remains unverified. No second act on the same thing.`;
}
