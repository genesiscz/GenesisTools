import { existsSync } from "node:fs";
import { attachmentFilePath } from "./attachments";
import type {
    FoldOutcome,
    Handoff,
    HandoffActor,
    HandoffEvent,
    HandoffEventBy,
    HandoffTask,
    HandoffTaskInput,
} from "./types";

export interface FoldConfig {
    /** Log/attachments base dir override (tests). */
    base?: string;
}

/** Null never establishes identity and never matches another null (spec §3). */
export function sessionIdMatches(a: string | null | undefined, b: string | null | undefined): boolean {
    return a != null && b != null && a === b;
}

/** Dashboard owner authority (§7.1): a distinct actor kind, never a session identity. */
export function isHumanOwner(by: HandoffEventBy): boolean {
    return by.agent === "human" && by.via === "dashboard";
}

/**
 * Claim identity (G11): sessionId match when non-null; else human-owner match
 * (`agent === "human"` on the claim, mirrored by isHumanOwner on the event).
 */
export function claimMatches(claim: { sessionId: string | null; agent: string }, by: HandoffEventBy): boolean {
    if (sessionIdMatches(claim.sessionId, by.sessionId)) {
        return true;
    }

    if (by.sessionId == null && isHumanOwner(by) && claim.agent === "human") {
        return true;
    }

    return false;
}

export function actorOf(by: HandoffEventBy): HandoffActor {
    const actor: HandoffActor = {
        sessionId: by.sessionId,
        sessionName: by.sessionTitle,
        agent: by.agent,
    };

    if (by.via !== undefined) {
        actor.via = by.via;
    }

    return actor;
}

function isPoster(state: Handoff, event: HandoffEvent): boolean {
    if (isHumanOwner(event.by)) {
        return true;
    }

    if (sessionIdMatches(event.by.sessionId, state.postedBy.sessionId)) {
        return true;
    }

    return event.editId != null && event.editId === state.editId;
}

function isClaimer(state: Handoff, event: HandoffEvent): boolean {
    if (isHumanOwner(event.by)) {
        return true;
    }

    return state.claimedBy.some((c) => sessionIdMatches(c.sessionId, event.by.sessionId));
}

function taskIdCatalog(state: Handoff): string {
    return state.tasks.map((t) => t.id).join(", ") || "(none)";
}

function nextFreeTaskId(taken: Set<string>): string {
    let n = 1;

    while (taken.has(`t${n}`)) {
        n++;
    }

    return `t${n}`;
}

/**
 * Fold-time auto id assignment (§6.1 rule 3). `rejectExplicitCollisions` is the
 * add_tasks behavior (§2: supplied colliding id → item rejected, rest applies);
 * post reassigns instead (§1.1: final ids ALWAYS in the response).
 */
function assignTaskIds(
    inputs: HandoffTaskInput[],
    existing: HandoffTask[],
    opts: { rejectExplicitCollisions: boolean }
): { tasks: HandoffTask[]; assignedIds: string[]; rejected: string[] } {
    const taken = new Set(existing.map((t) => t.id));
    const tasks: HandoffTask[] = [];
    const assignedIds: string[] = [];
    const rejected: string[] = [];

    for (const input of inputs) {
        const text = typeof input.text === "string" ? input.text.trim() : "";

        if (text.length === 0) {
            rejected.push("(task with empty text)");
            continue;
        }

        let id: string;

        if (input.id !== undefined && input.id.trim().length > 0) {
            const wanted = input.id.trim();

            if (taken.has(wanted)) {
                if (opts.rejectExplicitCollisions) {
                    rejected.push(wanted);
                    continue;
                }

                id = nextFreeTaskId(taken);
            } else {
                id = wanted;
            }
        } else {
            id = nextFreeTaskId(taken);
        }

        taken.add(id);
        assignedIds.push(id);
        const task: HandoffTask = { id, text, checked: false, denied: false };

        if (input.acceptanceCriteria !== undefined && input.acceptanceCriteria.trim().length > 0) {
            task.acceptanceCriteria = input.acceptanceCriteria;
        }

        tasks.push(task);
    }

    return { tasks, assignedIds, rejected };
}

function rejected(error: string): { state: null; outcome: FoldOutcome } {
    return { state: null, outcome: { applied: false, error } };
}

const CLAIM_FIRST =
    'Not a claimer of this handoff — claim first: include { action: "claim" } as the first action, or call handoff_get with claim: true.';

const NOT_POSTER =
    "Poster credential required (same session that posted, or editId). Pass editId at the top level: " +
    'handoff_action { id, editId: "he_…", actions: […] }. Your user can read the editId on the dev-dashboard /qa Agent-tasks tab.';

export const DONE_INFO =
    'Handoff is done — reopen with handoff_action { actions: ["reopen_handoff"] } (poster, or the claimer whose own finish closed it).';

export const CANCELLED_INFO = "Cancelled by the poster — stop work, revert if asked. The poster can reopen_handoff.";

/**
 * Pure, deterministic fold of one event onto one handoff's current state
 * (spec §6.1). Same log → same state, always; every accept/reject decision is
 * derived from (state, event) only, so rebuilds converge (attachment `missing`
 * deliberately reflects current disk truth — §6.3).
 */
export function applyHandoffEvent(
    state: Handoff | null,
    event: HandoffEvent,
    cfg: FoldConfig = {}
): { state: Handoff | null; outcome: FoldOutcome } {
    if (event.ev === "post") {
        if (state !== null) {
            // First-wins (§6.1 rule 5) — caller logs loudly; never clobber.
            return {
                state,
                outcome: { applied: false, error: `Handoff ${event.id} already exists — post ignored (first wins).` },
            };
        }

        const {
            tasks,
            assignedIds,
            rejected: rejectedIds,
        } = assignTaskIds(event.tasks, [], {
            rejectExplicitCollisions: false,
        });

        if (tasks.length === 0) {
            return rejected("post rejected: no valid tasks (each task needs non-empty text).");
        }

        const next: Handoff = {
            id: event.id,
            title: event.title,
            status: "open",
            tasks,
            postedBy: actorOf(event.by),
            postedByContext: event.by,
            project: event.by.project,
            claimedBy: [],
            comments: [],
            attachments: [],
            editId: event.editId,
            createdTs: event.ts,
            updatedTs: event.ts,
        };

        if (event.description !== undefined) {
            next.description = event.description;
        }

        if (event.target !== undefined) {
            next.target = event.target;
        }

        if (event.refs !== undefined) {
            next.refs = event.refs;
        }

        const outcome: FoldOutcome = { applied: true, assignedTaskIds: assignedIds };

        if (rejectedIds.length > 0) {
            outcome.info = [`Skipped invalid task entries: ${rejectedIds.join(", ")}.`];
        }

        return { state: next, outcome };
    }

    if (state === null) {
        return rejected(`No handoff ${event.id} — re-check the paste block or call handoff_list to find it.`);
    }

    // Terminal-state gate: done/cancelled reject every mutation except reopen (§3).
    if ((state.status === "done" || state.status === "cancelled") && event.ev !== "reopen") {
        return { state, outcome: { applied: false, error: state.status === "done" ? DONE_INFO : CANCELLED_INFO } };
    }

    const next: Handoff = {
        ...state,
        tasks: state.tasks.map((t) => ({ ...t })),
        claimedBy: state.claimedBy.map((c) => ({ ...c })),
        comments: [...state.comments],
        attachments: [...state.attachments],
    };
    next.updatedTs = event.ts;

    const findTask = (taskId: string): HandoffTask | undefined => next.tasks.find((t) => t.id === taskId);

    switch (event.ev) {
        case "claim": {
            if (event.by.sessionId == null && !isHumanOwner(event.by)) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: "This session has no sessionId — it cannot claim. Ask the posting session to act, or run from a real agent session (the poster can act with editId).",
                    },
                };
            }

            const mine = next.claimedBy.find((c) => claimMatches(c, event.by));

            if (mine) {
                mine.claimedAt = event.ts;
                return { state: next, outcome: { applied: true, noop: true, info: ["Already claimed by you."] } };
            }

            next.claimedBy.push({
                sessionId: event.by.sessionId,
                sessionName: event.by.sessionTitle,
                branch: event.by.branch,
                cwd: event.by.cwd,
                claimedAt: event.ts,
                via: event.via,
                repoRoot: event.by.repoRoot,
                commitSha: event.by.commitSha,
                agent: event.by.agent,
            });

            if (next.status === "open") {
                next.status = "claimed";
            }

            return { state: next, outcome: { applied: true } };
        }

        case "unclaim": {
            const before = next.claimedBy.length;
            next.claimedBy = next.claimedBy.filter((c) => !claimMatches(c, event.by));

            if (next.claimedBy.length === before) {
                return {
                    state: next,
                    outcome: {
                        applied: true,
                        noop: true,
                        info: ["You had no claim on this handoff — nothing to unclaim."],
                    },
                };
            }

            if (next.claimedBy.length === 0 && next.status === "claimed") {
                next.status = "open";
            }

            return { state: next, outcome: { applied: true } };
        }

        case "check_task": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const task = findTask(event.taskId);

            if (!task) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            if (task.denied && event.force !== true) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Task ${task.id} is denied ("${task.deniedReason ?? ""}") — pass force: true to check it anyway (clears the denial).`,
                    },
                };
            }

            if (task.denied) {
                task.denied = false;
                delete task.deniedReason;
                delete task.deniedBy;
                delete task.deniedTs;
            }

            task.checked = true;
            task.proof = event.proof;
            task.checkedBy = actorOf(event.by);
            task.checkedTs = event.ts;
            return { state: next, outcome: { applied: true } };
        }

        case "uncheck_task": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const task = findTask(event.taskId);

            if (!task) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            // Keep proof on uncheck (redesign G8) — activity trace shows the uncheck;
            // UI renders surviving proof as a dimmed "previous proof" block.
            task.checked = false;
            delete task.checkedBy;
            delete task.checkedTs;
            return { state: next, outcome: { applied: true } };
        }

        case "deny_task": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const task = findTask(event.taskId);

            if (!task) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            if (typeof event.reason !== "string" || event.reason.trim().length === 0) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `deny_task needs a reason — e.g. { action: "deny_task", taskId: "${task.id}", reason: "out of scope for this repo" }.`,
                    },
                };
            }

            if (task.checked && event.force !== true) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Task ${task.id} is checked — pass force: true to deny anyway (proof stays visible).`,
                    },
                };
            }

            // checked + proof stay as-is under a forced deny (§4 rule 4); undeny returns to them.
            task.denied = true;
            task.deniedReason = event.reason;
            task.deniedBy = actorOf(event.by);
            task.deniedTs = event.ts;
            return { state: next, outcome: { applied: true } };
        }

        case "undeny_task": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const task = findTask(event.taskId);

            if (!task) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            if (!task.denied) {
                return {
                    state: next,
                    outcome: { applied: true, noop: true, info: [`Task ${task.id} is not denied.`] },
                };
            }

            task.denied = false;
            delete task.deniedReason;
            delete task.deniedBy;
            delete task.deniedTs;
            return { state: next, outcome: { applied: true } };
        }

        case "comment": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const comment = { text: event.text, by: actorOf(event.by), ts: event.ts } as Handoff["comments"][number];

            if (event.attachmentIds !== undefined && event.attachmentIds.length > 0) {
                comment.attachmentIds = event.attachmentIds;
            }

            next.comments.push(comment);
            return { state: next, outcome: { applied: true } };
        }

        case "attach": {
            if (!isClaimer(next, event) && !isPoster(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            if (event.taskId !== undefined && !findTask(event.taskId)) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            const filePath = attachmentFilePath(next.id, event.attachmentId, event.filename, cfg.base);
            const attachment: Handoff["attachments"][number] = {
                attachmentId: event.attachmentId,
                filename: event.filename,
                mime: event.mime,
                bytes: event.bytes,
                by: actorOf(event.by),
                ts: event.ts,
            };

            if (event.taskId !== undefined) {
                attachment.taskId = event.taskId;
            }

            if (event.note !== undefined) {
                attachment.note = event.note;
            }

            if (!existsSync(filePath)) {
                attachment.missing = true;
            }

            next.attachments.push(attachment);
            return { state: next, outcome: { applied: true } };
        }

        case "add_tasks": {
            if (!isPoster(next, event)) {
                return { state, outcome: { applied: false, error: NOT_POSTER } };
            }

            const {
                tasks,
                assignedIds,
                rejected: rejectedIds,
            } = assignTaskIds(event.tasks, next.tasks, {
                rejectExplicitCollisions: true,
            });

            if (tasks.length === 0) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `add_tasks: no valid tasks to add${rejectedIds.length > 0 ? ` (rejected: ${rejectedIds.join(", ")})` : ""}. Each task needs non-empty text; supplied ids must not collide (existing: ${taskIdCatalog(next)}).`,
                    },
                };
            }

            next.tasks.push(...tasks);
            const outcome: FoldOutcome = { applied: true, assignedTaskIds: assignedIds };

            if (rejectedIds.length > 0) {
                outcome.info = [
                    `Rejected colliding/invalid task entries: ${rejectedIds.join(", ")} — the rest applied.`,
                ];
            }

            return { state: next, outcome };
        }

        case "modify_task": {
            if (!isPoster(next, event)) {
                return { state, outcome: { applied: false, error: NOT_POSTER } };
            }

            const task = findTask(event.taskId);

            if (!task) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Unknown taskId "${event.taskId}" — this handoff's tasks are: ${taskIdCatalog(next)}.`,
                    },
                };
            }

            if (event.text !== undefined && event.text.trim().length > 0) {
                task.text = event.text;
            }

            if (event.acceptanceCriteria !== undefined) {
                if (event.acceptanceCriteria.trim().length === 0) {
                    delete task.acceptanceCriteria;
                } else {
                    task.acceptanceCriteria = event.acceptanceCriteria;
                }
            }

            return { state: next, outcome: { applied: true } };
        }

        case "modify_handoff": {
            if (!isPoster(next, event)) {
                return { state, outcome: { applied: false, error: NOT_POSTER } };
            }

            if (event.title !== undefined && event.title.trim().length > 0) {
                next.title = event.title;
            }

            if (event.description !== undefined) {
                if (event.description.length === 0) {
                    delete next.description;
                } else {
                    next.description = event.description;
                }
            }

            if (event.target !== undefined) {
                if (event.target === null) {
                    delete next.target;
                } else {
                    next.target = event.target;
                }
            }

            if (event.refs !== undefined) {
                next.refs = event.refs;
            }

            return { state: next, outcome: { applied: true } };
        }

        case "finish": {
            if (!isClaimer(next, event)) {
                return { state, outcome: { applied: false, error: CLAIM_FIRST } };
            }

            const openTasks = next.tasks.filter((t) => !t.checked && !t.denied).map((t) => t.id);

            if (openTasks.length > 0 && event.force !== true) {
                return {
                    state,
                    outcome: {
                        applied: false,
                        error: `Cannot finish — unresolved tasks: ${openTasks.join(", ")}. Check or deny them, or pass force: true.`,
                    },
                };
            }

            next.status = "done";
            next.finishedTs = event.ts;
            next.finishedBy = actorOf(event.by);
            return { state: next, outcome: { applied: true } };
        }

        case "cancel": {
            if (!isPoster(next, event)) {
                return { state, outcome: { applied: false, error: NOT_POSTER } };
            }

            next.status = "cancelled";
            return { state: next, outcome: { applied: true } };
        }

        case "reopen": {
            if (next.status !== "done" && next.status !== "cancelled") {
                return {
                    state,
                    outcome: { applied: true, noop: true, info: [`Handoff is ${next.status} — nothing to reopen.`] },
                };
            }

            const finisherReopens =
                next.status === "done" && sessionIdMatches(next.finishedBy?.sessionId ?? null, event.by.sessionId);

            if (!isPoster(next, event) && !finisherReopens) {
                const who =
                    next.status === "done" ? "the poster or the claimer whose own finish closed it" : "the poster";
                return {
                    state,
                    outcome: { applied: false, error: `Only ${who} can reopen this handoff.` },
                };
            }

            // Status flip ONLY — per-task checked/denied state untouched (§2).
            next.status = next.claimedBy.length > 0 ? "claimed" : "open";
            delete next.finishedTs;
            delete next.finishedBy;
            return { state: next, outcome: { applied: true } };
        }

        default: {
            const unknown = event as { ev: string };
            return { state, outcome: { applied: false, error: `Unknown event "${unknown.ev}" — ignored.` } };
        }
    }
}
