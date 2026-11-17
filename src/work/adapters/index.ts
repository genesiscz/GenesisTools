/**
 * The tool-side halves of the work package's ports: the caller, the old handoff store, session delivery and the
 * lineage of a T3 child thread.
 */
import { basename, dirname } from "node:path";
import { executeHandoffActions, type HandoffDeps, postHandoff } from "@app/handoff/executor";
import { deliverToSession, isLiveDelivery, locateDelivery } from "@app/question/lib/decisions/deliver";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { gitCommonRoot } from "@genesiscz/utils/agent/identity";
import { logger } from "@genesiscz/utils/logger";
import { t3SessionThreads } from "@genesiscz/utils/t3code/session-threads";
import type { Actor } from "@genesiscz/utils/work/model/item";
import type {
    DeliveryReceipt,
    LegacyAction,
    LegacyHandoffs,
    LegacyWriteResult,
    LineageResolver,
    SessionDelivery,
} from "@genesiscz/utils/work/ports";

const log = logger.child({ component: "work:adapters" });

/** The calling session as an actor, and its project: the folder name of the main checkout. */
export function actorHere(): { actor: Actor; project: string } {
    const identity = whoIsCallingHere({ facets: ["cwd", "git", "title", "model", "host"] });
    const cwd = identity.cwd ?? process.cwd();
    const common = gitCommonRoot(cwd);
    // The common git dir is `<main checkout>/.git`; the project is the main checkout's folder name.
    const project = common !== null ? basename(dirname(common)) : (identity.project ?? basename(cwd));
    const actor: Actor = {
        kind: identity.isInAgent ? "agent" : "owner",
        harness: identity.agent,
        sessionId: identity.sessionId,
        sessionTitle: identity.sessionTitle ?? null,
        model: identity.model ?? null,
        host: identity.host ?? null,
        subagentId: identity.subagentId ?? null,
        project,
        repoRoot: identity.repoRoot ?? null,
        branch: identity.branch ?? null,
        commitSha: identity.commitSha ?? null,
    };
    return { actor, project };
}

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

/** A delegated T3 child's lead: the native sessions of its parent thread. */
export function t3Lineage(): LineageResolver {
    return {
        async leadSessions({ sessionId, parentThreadId }) {
            const threads = t3SessionThreads();
            const parent = parentThreadId ?? (sessionId !== null ? (threads.get(sessionId)?.parent?.id ?? null) : null);

            if (parent === null) {
                return [];
            }

            const leads: string[] = [];

            for (const [native, thread] of threads) {
                if (thread.threadId === parent) {
                    leads.push(native);
                }
            }

            return leads;
        },
    };
}
