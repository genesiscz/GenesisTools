/**
 * The tool-side halves of the work package's ports: the caller, the old handoff store, session delivery and the
 * lineage of a T3 child thread.
 */
// lint-rules-ignore: the adapter of the LegacyHandoffs port writes through the old executor until the switch (spec P1, P10)
import { executeHandoffActions, type HandoffDeps, postHandoff } from "@app/handoff/executor";
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

/** Writes into the old handoff log through its own executor; its hook brings each event into the work store. */
export function legacyHandoffs(deps: HandoffDeps = {}): LegacyHandoffs {
    return {
        async write(action: LegacyAction): Promise<LegacyWriteResult> {
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
                        deps
                    );
                    return { ok: true, handoff: posted.handoff.id, taskIds: posted.handoff.tasks.map((t) => t.id) };
                }

                const { handoff, ...rest } = action;
                const response = executeHandoffActions(
                    { id: handoff, actions: [{ ...rest }], include: ["tasks"] },
                    deps
                );
                const result = response.results[0];

                if (result === undefined || !result.ok) {
                    return { ok: false, error: result?.error ?? "the old store applied nothing" };
                }

                return { ok: true, handoff, ...(result.assignedTaskIds ? { taskIds: result.assignedTaskIds } : {}) };
            } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

                if (result.channel === "queued") {
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
