/**
 * The tool-side halves of the work package's ports: the caller, the old handoff store, session delivery and the
 * lineage of a T3 child thread.
 */
// lint-rules-ignore: the adapter of the LegacyHandoffs port writes through the old executor until the switch (spec P1, P10)
import {
    checkHandoffActions,
    executeHandoffActions,
    type HandoffDeps,
    posterEditId,
    postHandoff,
} from "@app/handoff/executor";
// lint-rules-ignore: the Work adapter folds handoff events on the same transaction as the Work item
import { catchUpHandoffs, ensureHandoffModel, flushHandoffCopies, handoffDbPath } from "@app/handoff/read-model";
// lint-rules-ignore: the type of the old executor's input, for the same LegacyHandoffs adapter until P10 removes it
import type { HandoffActionInput } from "@app/handoff/types";
// lint-rules-ignore: the adapter of the SessionDelivery port wraps deliverToSession until the sessions area exists (spec, Session delivery)
import { deliverToSession, isLiveDelivery, locateDelivery } from "@app/question/lib/decisions/deliver";

import { logger } from "@genesiscz/utils/logger";
import type {
    DeliveryReceipt,
    LegacyAction,
    LegacyHandoffs,
    LegacyWriteResult,
    SessionDelivery,
} from "@genesiscz/utils/work/ports";

export { actorHere } from "./actor";

const log = logger.child({ component: "work:adapters" });

/** The old executor's input for one action on an existing handoff; the owner's add uses the poster credential. */
function executorInput(
    action: Exclude<LegacyAction, { action: "post" }>,
    deps: HandoffDeps,
    preview = false
): { id: string; editId?: string; asOwner?: boolean; actions: HandoffActionInput[] } {
    const { handoff, ...rest } = action;
    const asOwner = rest.action === "add_tasks" && rest.asOwner === true;
    const editId = asOwner && !preview ? posterEditId(handoff, deps) : undefined;
    const input = rest.action === "add_tasks" ? { action: rest.action, tasks: rest.tasks } : rest;
    return {
        id: handoff,
        ...(editId !== undefined ? { editId } : {}),
        ...(asOwner && preview ? { asOwner: true } : {}),
        actions: [{ ...input }],
    };
}

function failed(error: unknown): LegacyWriteResult {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Writes into the old handoff log through its own executor; its hook brings each event into the work store. */
export function legacyHandoffs(deps: HandoffDeps = {}): LegacyHandoffs {
    function write(action: LegacyAction, operation: HandoffDeps): LegacyWriteResult {
        try {
            if (action.action === "post") {
                const posted = postHandoff(
                    {
                        title: action.title,
                        tasks: action.tasks,
                        ...(action.description !== undefined ? { description: action.description } : {}),
                        ...(action.project !== undefined ? { project: action.project } : {}),
                        ...(action.target !== undefined ? { target: action.target } : {}),
                    },
                    operation
                );
                return { ok: true, handoff: posted.handoff.id, taskIds: posted.handoff.tasks.map((t) => t.id) };
            }

            const response = executeHandoffActions(
                { ...executorInput(action, operation), include: ["tasks"] },
                operation
            );
            const result = response.results[0];

            if (result === undefined || !result.ok) {
                return { ok: false, error: result?.error ?? "the old store applied nothing" };
            }

            return {
                ok: true,
                handoff: action.handoff,
                ...(result.assignedTaskIds ? { taskIds: result.assignedTaskIds } : {}),
            };
        } catch (error) {
            return failed(error);
        }
    }

    return {
        async write(action, operationId) {
            return write(action, operationId === undefined ? deps : { ...deps, workOperationId: operationId });
        },
        atomic(db) {
            if (db.filename !== (deps.dbPath ?? handoffDbPath())) {
                return undefined;
            }
            return {
                write(action) {
                    ensureHandoffModel(db);
                    catchUpHandoffs(db, deps.base);
                    return write(action, { ...deps, transactionDb: db });
                },
                flush: () => flushHandoffCopies(db),
            };
        },

        async check(actions: LegacyAction[]): Promise<LegacyWriteResult[]> {
            // A post makes a new handoff, which nothing can refuse for its credential; the rest fold in memory.
            const onHandoffs = actions.filter(
                (a): a is Exclude<LegacyAction, { action: "post" }> => a.action !== "post"
            );

            try {
                const answers = checkHandoffActions(
                    onHandoffs.map((a) => executorInput(a, deps, true)),
                    deps
                );
                let next = 0;
                return actions.map((action): LegacyWriteResult => {
                    if (action.action === "post") {
                        return { ok: true };
                    }

                    const answer = answers[next++]?.[0];
                    return answer?.ok
                        ? { ok: true }
                        : { ok: false, error: answer?.error ?? "the old store would apply nothing" };
                });
            } catch (error) {
                return actions.map(() => failed(error));
            }
        },
    };
}

/** Wraps `deliverToSession`; a later session-host area gives `place()` and the wake option instead. */
export function sessionDelivery(): SessionDelivery {
    return {
        async place(sessionId, harness) {
            try {
                const located = await locateDelivery({
                    session: sessionId,
                    ...(harness !== undefined ? { provider: harness } : {}),
                });

                if (!isLiveDelivery(located)) {
                    return { label: "no live place", live: false };
                }

                return { label: located.target.kind, live: true };
            } catch (error) {
                log.debug({ err: error, sessionId }, "work: the place lookup failed");
                return null;
            }
        },
        async deliver({ sessionId, harness, text, key }): Promise<DeliveryReceipt> {
            const at = new Date().toISOString();
            const to = { kind: "agent" as const, harness, sessionId, sessionTitle: null, model: null, host: null };

            try {
                const result = await deliverToSession({
                    session: sessionId,
                    provider: harness,
                    text,
                    deliveryKey: key,
                });

                if (result.delivered) {
                    return {
                        outcome: "delivered",
                        to,
                        route: result.channel,
                        ...(result.target ? { target: result.target } : {}),
                        at,
                    };
                }

                if (result.channel === "queued" && result.queueId !== undefined) {
                    return { outcome: "queued", to, route: result.channel, at };
                }

                return {
                    outcome: "unknown",
                    to,
                    route: result.channel,
                    ...(result.error ? { target: result.error } : {}),
                    at,
                };
            } catch (error) {
                log.warn(
                    { err: error, sessionId },
                    "work: the delivery threw; its outcome is unknown and it is not sent again"
                );
                return { outcome: "unknown", to, at };
            }
        },
    };
}

export { t3Lineage } from "./lineage";
