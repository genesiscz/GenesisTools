import type { Database } from "bun:sqlite";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent-runtime";
import { getAgentRuntimeContext } from "@genesiscz/utils/agent-runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { attachmentFilePath, ingestAttachmentBytes, ingestAttachmentFromPath } from "./attachments";
import { CANCELLED_INFO, DONE_INFO, isHumanOwner, sessionIdMatches } from "./fold";
import { generateEditId, generateEventUid, generateHandoffId, normalizeEditId, normalizeHandoffId } from "./ids";
import { appendHandoffEvents } from "./log-store";
import { catchUpHandoffs, getEventOutcome, getHandoffById, listHandoffRows, openHandoffModel } from "./read-model";
import type {
    Handoff,
    HandoffActionInput,
    HandoffActionResult,
    HandoffEvent,
    HandoffEventBy,
    HandoffListRow,
    HandoffProof,
    HandoffTarget,
    HandoffTaskInput,
} from "./types";

const log = logger.child({ component: "handoff:executor" });

export interface HandoffDeps {
    /** Log + attachment store base dir override (tests). */
    base?: string;
    /** qa.db path override (tests). */
    dbPath?: string;
    /** AgentRuntimeContext overrides (tests / explicit session). */
    ctx?: Partial<AgentRuntimeContext>;
    /** Full actor override — the dashboard's owner-authority human actor (§7.1). */
    by?: HandoffEventBy;
    nowIso?: () => string;
}

export const DASHBOARD_ACTOR: HandoffEventBy = {
    sessionId: null,
    sessionTitle: "dev-dashboard",
    agent: "human",
    aiAgent: null,
    branch: null,
    cwd: null,
    repoRoot: null,
    project: null,
    commitSha: null,
    isWorktree: false,
    via: "dashboard",
};

function buildBy(deps: HandoffDeps): HandoffEventBy {
    if (deps.by !== undefined) {
        return deps.by;
    }

    const ctx = getAgentRuntimeContext(deps.ctx ?? {});
    return {
        sessionId: ctx.sessionId,
        sessionTitle: ctx.sessionTitle,
        agent: ctx.agent,
        aiAgent: ctx.aiAgent,
        branch: ctx.branch,
        cwd: ctx.cwd,
        repoRoot: ctx.repoRoot,
        project: ctx.project,
        commitSha: ctx.commitSha,
        isWorktree: ctx.isWorktree,
    };
}

function withDb<T>(deps: HandoffDeps, fn: (db: Database) => T): T {
    const db = openHandoffModel(deps.dbPath);

    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function nowIso(deps: HandoffDeps): string {
    return deps.nowIso !== undefined ? deps.nowIso() : new Date().toISOString();
}

/** The response-facing handoff: editId stripped (returned separately, only when entitled). */
export type PublicHandoff = Omit<Handoff, "editId"> & {
    attachments: (Handoff["attachments"][number] & { path?: string })[];
};

function publicHandoff(h: Handoff, base?: string): PublicHandoff {
    const { editId: _editId, ...rest } = h;
    return {
        ...rest,
        attachments: h.attachments.map((a) =>
            a.missing === true ? { ...a } : { ...a, path: attachmentFilePath(h.id, a.attachmentId, a.filename, base) }
        ),
    };
}

function isClaimedBy(h: Handoff, by: HandoffEventBy): boolean {
    return h.claimedBy.some((c) => sessionIdMatches(c.sessionId, by.sessionId));
}

function isPosterSession(h: Handoff, by: HandoffEventBy): boolean {
    return sessionIdMatches(h.postedBy.sessionId, by.sessionId);
}

function progress(h: Handoff): { resolved: number; total: number; denied: number } {
    const denied = h.tasks.filter((t) => t.denied).length;
    const resolved = h.tasks.filter((t) => t.checked || t.denied).length;
    return { resolved, total: h.tasks.length, denied };
}

function claimantNames(h: Handoff, excludeBy?: HandoffEventBy): string[] {
    return h.claimedBy
        .filter((c) => excludeBy === undefined || !sessionIdMatches(c.sessionId, excludeBy.sessionId))
        .map((c) => c.sessionName ?? c.sessionId ?? "unnamed session");
}

/** State-aware info lines (§5) — every response gets ≥1 line ending in the ONE next step. */
function stateInfo(h: Handoff, by: HandoffEventBy): string[] {
    const lines: string[] = [];

    if (h.status === "done") {
        lines.push(DONE_INFO);
        return lines;
    }

    if (h.status === "cancelled") {
        lines.push(CANCELLED_INFO);
        return lines;
    }

    const mine = isClaimedBy(h, by);

    if (h.claimedBy.length === 0) {
        lines.push(
            `NOT claimed — claim it with handoff_get { id: "${h.id}", claim: true } (or include { action: "claim" } first in handoff_action) before working.`
        );

        if (
            h.target?.sessionName != null &&
            by.sessionTitle != null &&
            h.target.sessionName === by.sessionTitle &&
            !mine
        ) {
            lines.push(
                `This handoff targets sessionName "${h.target.sessionName}" — that matches this session's name, but names aren't unique so it never auto-claims; claim explicitly.`
            );
        }
    } else if (mine) {
        const others = claimantNames(h, by);
        lines.push(others.length === 0 ? "Claimed by you." : `Claimed by you and ${others.join(", ")} (co-owned).`);
    } else {
        lines.push(`Claimed by ${claimantNames(h).join(", ")} — claiming too will co-own it.`);
    }

    const p = progress(h);

    if (p.total > 0 && p.resolved === p.total) {
        lines.push('All tasks resolved — call handoff_action { actions: ["finish_handoff"] }.');
    }

    return lines;
}

function pasteAgentText(id: string): string {
    return (
        `You have been handed a task list. Call the genesis-tools MCP tool handoff_get with { id: "${id}" } to read it, ` +
        `then claim it by calling handoff_get again with { id: "${id}", claim: true } before working. ` +
        'Check each finished task off with handoff_action { id, actions: [{ action: "check_task", taskId, proof: { answer, commitIds } }] }. ' +
        'To refuse a task you can\'t do, send { action: "deny_task", taskId, reason }. ' +
        'When every task is checked or denied, send { action: "finish_handoff" }. ' +
        "If the id doesn't resolve, call handoff_list to find it. " +
        "If you don't have the genesis-tools MCP tools, tell your user to enable the genesis-tools MCP server."
    );
}

// ---------------------------------------------------------------------------
// handoff_post
// ---------------------------------------------------------------------------

export interface PostHandoffInput {
    title: string;
    description?: string;
    tasks: HandoffTaskInput[];
    target?: HandoffTarget;
    refs?: string[];
}

export interface PostHandoffResponse {
    handoff: PublicHandoff;
    editId: string;
    paste: { _agent: string; id: string; title: string; tasks: string };
    info: string[];
}

export function postHandoff(input: PostHandoffInput, deps: HandoffDeps = {}): PostHandoffResponse {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];

    if (
        title.length === 0 ||
        tasks.length === 0 ||
        tasks.some((t) => typeof t.text !== "string" || t.text.trim().length === 0)
    ) {
        throw new Error(
            'handoff_post needs title and ≥1 task with text — e.g. { title: "Fix e2e Active-filter semantics", tasks: [{ text: "Make the Active filter exclude archived rows", acceptanceCriteria: "e2e filters.spec green" }] }.'
        );
    }

    const by = buildBy(deps);
    const event: HandoffEvent = {
        ev: "post",
        ts: nowIso(deps),
        uid: generateEventUid(),
        id: generateHandoffId(),
        editId: generateEditId(),
        title,
        tasks,
        by,
    };

    if (input.description !== undefined && input.description.trim().length > 0) {
        event.description = input.description;
    }

    if (
        input.target !== undefined &&
        (input.target.sessionId !== undefined || input.target.sessionName !== undefined)
    ) {
        event.target = input.target;
    }

    if (input.refs !== undefined && input.refs.length > 0) {
        event.refs = input.refs;
    }

    appendHandoffEvents([event], deps.base);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const handoff = getHandoffById(db, event.id);

        if (handoff === null) {
            throw new Error(`handoff_post failed to fold ${event.id} — check ~/.genesis-tools/logs for details.`);
        }

        log.info({ id: handoff.id, tasks: handoff.tasks.length, by: by.sessionId }, "handoff posted");

        return {
            handoff: publicHandoff(handoff, deps.base),
            editId: event.editId,
            paste: {
                _agent: pasteAgentText(handoff.id),
                id: handoff.id,
                title: handoff.title,
                tasks: `0/${handoff.tasks.length}`,
            },
            info: [
                "Posted. Copy `paste` into the target agent's chat.",
                "You can edit from this session anytime via handoff_action (no editId needed).",
            ],
        };
    });
}

// ---------------------------------------------------------------------------
// handoff_get
// ---------------------------------------------------------------------------

export interface GetHandoffInput {
    id: string;
    claim?: boolean;
    unclaim?: boolean;
}

export interface GetHandoffResponse {
    handoff: PublicHandoff;
    editId?: string;
    info: string[];
}

export function getHandoff(input: GetHandoffInput, deps: HandoffDeps = {}): GetHandoffResponse {
    if (input.claim === true && input.unclaim === true) {
        throw new Error(
            `Pass either claim: true or unclaim: true, not both — e.g. handoff_get { id: "${input.id}", claim: true }.`
        );
    }

    const id = normalizeHandoffId(String(input.id ?? ""));
    const by = buildBy(deps);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const existing = getHandoffById(db, id);

        if (existing === null) {
            throw new Error(`No handoff ${id} — re-check the paste block or call handoff_list to find it.`);
        }

        const events: HandoffEvent[] = [];
        const extraInfo: string[] = [];
        let autoClaimUid: string | undefined;
        let claimUid: string | undefined;
        let unclaimUid: string | undefined;

        const autoClaim =
            input.unclaim !== true &&
            existing.target?.sessionId !== undefined &&
            sessionIdMatches(existing.target.sessionId, by.sessionId) &&
            !isClaimedBy(existing, by) &&
            (existing.status === "open" || existing.status === "claimed");

        if (autoClaim) {
            autoClaimUid = generateEventUid();
            events.push({ ev: "claim", ts: nowIso(deps), uid: autoClaimUid, id, via: "target-match", by });
        }

        if (input.claim === true && !autoClaim) {
            claimUid = generateEventUid();
            events.push({ ev: "claim", ts: nowIso(deps), uid: claimUid, id, via: "explicit", by });
        }

        if (input.unclaim === true) {
            unclaimUid = generateEventUid();
            events.push({ ev: "unclaim", ts: nowIso(deps), uid: unclaimUid, id, by });
        }

        if (events.length > 0) {
            appendHandoffEvents(events, deps.base);
            catchUpHandoffs(db, deps.base);
        }

        const handoff = getHandoffById(db, id);

        if (handoff === null) {
            throw new Error(`No handoff ${id} — re-check the paste block or call handoff_list to find it.`);
        }

        if (autoClaimUid !== undefined) {
            const outcome = getEventOutcome(db, autoClaimUid);

            if (outcome?.applied === true) {
                extraInfo.push(
                    `Auto-claimed: this session IS the handoff's target sessionId. Undo with handoff_get { id: "${id}", unclaim: true }.`
                );
            } else if (outcome?.error !== undefined) {
                extraInfo.push(outcome.error);
            }
        }

        if (claimUid !== undefined) {
            const outcome = getEventOutcome(db, claimUid);

            if (outcome?.error !== undefined) {
                extraInfo.push(outcome.error);
            } else if (outcome?.info !== undefined) {
                extraInfo.push(...outcome.info);
            }
        }

        if (unclaimUid !== undefined) {
            const outcome = getEventOutcome(db, unclaimUid);

            if (outcome?.info !== undefined) {
                extraInfo.push(...outcome.info);
            }
        }

        const response: GetHandoffResponse = {
            handoff: publicHandoff(handoff, deps.base),
            info: [...extraInfo, ...stateInfo(handoff, by)],
        };

        // editId recovery: ONLY the posting session (or the dashboard owner) ever sees it (§3).
        if (isPosterSession(handoff, by) || isHumanOwner(by)) {
            response.editId = handoff.editId;
        }

        return response;
    });
}

// ---------------------------------------------------------------------------
// handoff_list
// ---------------------------------------------------------------------------

export interface ListHandoffsInput {
    limit?: number;
    offset?: number;
    mine?: boolean;
    open?: boolean;
    project?: string;
}

export interface ListHandoffsResponse {
    handoffs: HandoffListRow[];
    info: string[];
}

export function listHandoffs(input: ListHandoffsInput = {}, deps: HandoffDeps = {}): ListHandoffsResponse {
    const by = buildBy(deps);
    const limit = input.limit !== undefined && input.limit > 0 ? input.limit : 20;
    const offset = input.offset !== undefined && input.offset > 0 ? input.offset : 0;

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        let rows = listHandoffRows(db, {
            statuses: input.open === true ? ["open", "claimed"] : undefined,
            project: input.project,
        });

        if (input.mine === true) {
            rows = rows.filter(
                (h) =>
                    isPosterSession(h, by) ||
                    isClaimedBy(h, by) ||
                    sessionIdMatches(h.target?.sessionId ?? null, by.sessionId) ||
                    (h.target?.sessionName != null &&
                        by.sessionTitle != null &&
                        h.target.sessionName === by.sessionTitle)
            );
        }

        const total = rows.length;
        const page = rows.slice(offset, offset + limit);
        const now = Date.now();
        const handoffs = page.map((h): HandoffListRow => {
            const p = progress(h);
            const row: HandoffListRow = {
                id: h.id,
                title: h.title,
                status: h.status,
                tasks: `${p.resolved}/${p.total}`,
                postedBy: { sessionName: h.postedBy.sessionName },
                project: h.project,
                ageHours: Math.round(((now - new Date(h.createdTs).getTime()) / 3_600_000) * 10) / 10,
            };

            if (h.target !== undefined) {
                row.target = h.target;
            }

            if (h.claimedBy.length > 0) {
                row.claimedBy = h.claimedBy.map((c) => ({ sessionId: c.sessionId, sessionName: c.sessionName }));
                row.progress = `${p.resolved}/${p.total}${p.denied > 0 ? ` (${p.denied} denied)` : ""}`;
            }

            return row;
        });

        const info: string[] = [`${total} handoff${total === 1 ? "" : "s"} matched; showing ${page.length}.`];

        if (total > offset + page.length) {
            info.push(`More available — pass offset: ${offset + page.length}.`);
        }

        return { handoffs, info };
    });
}

// ---------------------------------------------------------------------------
// handoff_action
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
    done: "finish_handoff",
    finish: "finish_handoff",
    check: "check_task",
    add: "add_tasks",
    modify: "modify_task",
    deny: "deny_task",
    uncheck: "uncheck_task",
};

const VERBS = [
    "claim",
    "unclaim",
    "check_task",
    "uncheck_task",
    "deny_task",
    "undeny_task",
    "comment",
    "attach_file",
    "add_tasks",
    "modify_task",
    "modify_handoff",
    "finish_handoff",
    "cancel_handoff",
    "reopen_handoff",
] as const;

const VERB_CATALOG =
    `Valid actions: ${VERBS.join(", ")}. ` +
    "Aliases: done/finish→finish_handoff, check→check_task, add→add_tasks, modify→modify_task, deny→deny_task, uncheck→uncheck_task.";

const PROTECTED_TASK_FIELDS = [
    "checked",
    "proof",
    "checkedBy",
    "checkedTs",
    "denied",
    "deniedReason",
    "deniedBy",
    "deniedTs",
] as const;

interface PendingAction {
    index: number;
    action: string;
    result?: HandoffActionResult;
    event?: HandoffEvent;
    preEvents?: HandoffEvent[];
    shapeInfo?: string[];
    attachmentId?: string;
}

function shapeFail(index: number, action: string, error: string): PendingAction {
    return { index, action, result: { action, ok: false, error } };
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return undefined;
    }

    return value;
}

export interface ExecuteActionsInput {
    id: string;
    editId?: string;
    actions: HandoffActionInput[];
}

export interface ExecuteActionsResponse {
    handoff: PublicHandoff;
    results: HandoffActionResult[];
    info: string[];
}

export function executeHandoffActions(input: ExecuteActionsInput, deps: HandoffDeps = {}): ExecuteActionsResponse {
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
        throw new Error(
            'handoff_action needs an actions array — e.g. handoff_action { id: "h_x1y2z3ab", actions: [{ action: "check_task", taskId: "t1", proof: { answer: "…" } }] }. ' +
                VERB_CATALOG
        );
    }

    const id = normalizeHandoffId(String(input.id ?? ""));
    const editId = normalizeEditId(input.editId);
    const by = buildBy(deps);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const existing = getHandoffById(db, id);

        if (existing === null) {
            throw new Error(`No handoff ${id} — re-check the paste block or call handoff_list to find it.`);
        }

        const stamp = (): { ts: string; uid: string; id: string; by: HandoffEventBy; editId?: string } => ({
            ts: nowIso(deps),
            uid: generateEventUid(),
            id,
            by,
            ...(editId !== undefined ? { editId } : {}),
        });

        const pending: PendingAction[] = input.actions.map((raw, index) =>
            parseAction(raw, index, existing, stamp, deps)
        );

        const events = pending.flatMap((p) => [...(p.preEvents ?? []), ...(p.event !== undefined ? [p.event] : [])]);

        if (events.length > 0) {
            appendHandoffEvents(events, deps.base);
            catchUpHandoffs(db, deps.base);
        }

        const handoff = getHandoffById(db, id);

        if (handoff === null) {
            throw new Error(`No handoff ${id} after fold — check ~/.genesis-tools/logs for details.`);
        }

        const results = pending.map((p): HandoffActionResult => {
            if (p.result !== undefined) {
                return p.result;
            }

            const event = p.event;

            if (event === undefined) {
                return { action: p.action, ok: false, error: "internal: no event built" };
            }

            const outcome = getEventOutcome(db, event.uid);

            if (outcome === null) {
                return { action: p.action, ok: false, error: "internal: fold outcome missing — see logs." };
            }

            const result: HandoffActionResult = { action: p.action, ok: outcome.applied };
            const infoLines = [...(p.shapeInfo ?? []), ...(outcome.info ?? [])];

            if (outcome.error !== undefined) {
                result.error = outcome.error;
            }

            if (infoLines.length > 0) {
                result.info = infoLines;
            }

            if (outcome.assignedTaskIds !== undefined) {
                result.assignedTaskIds = outcome.assignedTaskIds;
            }

            if (p.attachmentId !== undefined) {
                result.attachmentId = p.attachmentId;
            }

            return result;
        });

        log.info(
            { id, actions: pending.map((p) => p.action), ok: results.filter((r) => r.ok).length, by: by.sessionId },
            "handoff actions executed"
        );

        return {
            handoff: publicHandoff(handoff, deps.base),
            results,
            info: stateInfo(handoff, by),
        };
    });
}

function ingestScreenshots(
    paths: string[],
    handoffId: string,
    taskId: string | undefined,
    stamp: () => { ts: string; uid: string; id: string; by: HandoffEventBy; editId?: string },
    deps: HandoffDeps
): { events: HandoffEvent[]; attachmentIds: string[] } {
    const events: HandoffEvent[] = [];
    const attachmentIds: string[] = [];

    for (const path of paths) {
        const ingested = ingestAttachmentFromPath(handoffId, path, deps.base);
        const event: HandoffEvent = {
            ev: "attach",
            ...stamp(),
            attachmentId: ingested.attachmentId,
            filename: ingested.filename,
            mime: ingested.mime,
            bytes: ingested.bytes,
        };

        if (taskId !== undefined) {
            event.taskId = taskId;
        }

        events.push(event);
        attachmentIds.push(ingested.attachmentId);
    }

    return { events, attachmentIds };
}

function parseAction(
    raw: HandoffActionInput,
    index: number,
    handoff: Handoff,
    stamp: () => { ts: string; uid: string; id: string; by: HandoffEventBy; editId?: string },
    deps: HandoffDeps
): PendingAction {
    let payload: { action: string } & Record<string, unknown>;

    if (typeof raw === "string") {
        payload = { action: raw };
    } else if (raw !== null && typeof raw === "object" && typeof raw.action === "string") {
        payload = raw;
    } else {
        return shapeFail(
            index,
            "(invalid)",
            'Each actions[] item is { action: "<verb>", …verb fields } or a bare verb string — e.g. { action: "check_task", taskId: "t1", proof: { answer: "…" } }. ' +
                VERB_CATALOG
        );
    }

    const requested = payload.action.trim();
    const verb = ALIASES[requested] ?? requested;

    if (!(VERBS as readonly string[]).includes(verb)) {
        return shapeFail(index, requested, `Unknown action "${requested}". ${VERB_CATALOG}`);
    }

    const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : undefined;

    switch (verb) {
        case "claim":
            return { index, action: verb, event: { ev: "claim", ...stamp(), via: "explicit" } };

        case "unclaim":
            return { index, action: verb, event: { ev: "unclaim", ...stamp() } };

        case "check_task": {
            const proofRaw = payload.proof as Record<string, unknown> | undefined;
            const answer = typeof proofRaw?.answer === "string" ? proofRaw.answer.trim() : "";

            if (taskId === undefined || answer.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    'check_task needs taskId and proof.answer — e.g. { action: "check_task", taskId: "t1", proof: { answer: "Implemented + bun test green (12/12)", commitIds: ["a1b2c3d"] } }.'
                );
            }

            const proof: HandoffProof = { answer };
            const commitIds = asStringArray(proofRaw?.commitIds);

            if (commitIds !== undefined && commitIds.length > 0) {
                proof.commitIds = commitIds;
            }

            if (typeof proofRaw?.context === "string" && proofRaw.context.trim().length > 0) {
                proof.context = proofRaw.context;
            }

            const existingIds = asStringArray(proofRaw?.attachmentIds) ?? [];
            const screenshots = asStringArray(proofRaw?.screenshots) ?? [];
            let preEvents: HandoffEvent[] = [];

            if (screenshots.length > 0) {
                try {
                    const ingest = ingestScreenshots(screenshots, handoff.id, taskId, stamp, deps);
                    preEvents = ingest.events;
                    proof.attachmentIds = [...existingIds, ...ingest.attachmentIds];
                } catch (err) {
                    return shapeFail(index, verb, err instanceof Error ? err.message : String(err));
                }
            } else if (existingIds.length > 0) {
                proof.attachmentIds = existingIds;
            }

            return {
                index,
                action: verb,
                preEvents,
                event: {
                    ev: "check_task",
                    ...stamp(),
                    taskId,
                    proof,
                    ...(payload.force === true ? { force: true } : {}),
                },
            };
        }

        case "uncheck_task": {
            if (taskId === undefined) {
                return shapeFail(
                    index,
                    verb,
                    'uncheck_task needs taskId — e.g. { action: "uncheck_task", taskId: "t1" }.'
                );
            }

            return { index, action: verb, event: { ev: "uncheck_task", ...stamp(), taskId } };
        }

        case "deny_task": {
            const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";

            if (taskId === undefined || reason.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    `deny_task needs taskId and reason — e.g. { action: "deny_task", taskId: "${taskId ?? "t1"}", reason: "out of scope for this repo" }.`
                );
            }

            return {
                index,
                action: verb,
                event: {
                    ev: "deny_task",
                    ...stamp(),
                    taskId,
                    reason,
                    ...(payload.force === true ? { force: true } : {}),
                },
            };
        }

        case "undeny_task": {
            if (taskId === undefined) {
                return shapeFail(
                    index,
                    verb,
                    'undeny_task needs taskId — e.g. { action: "undeny_task", taskId: "t1" }.'
                );
            }

            return { index, action: verb, event: { ev: "undeny_task", ...stamp(), taskId } };
        }

        case "comment": {
            const text = typeof payload.text === "string" ? payload.text.trim() : "";

            if (text.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    'comment needs text — e.g. { action: "comment", text: "starting on t2" }.'
                );
            }

            const attachmentIds = asStringArray(payload.attachmentIds) ?? [];
            const screenshots = asStringArray(payload.screenshots) ?? [];
            let preEvents: HandoffEvent[] = [];
            let allIds = attachmentIds;

            if (screenshots.length > 0) {
                try {
                    const ingest = ingestScreenshots(screenshots, handoff.id, undefined, stamp, deps);
                    preEvents = ingest.events;
                    allIds = [...attachmentIds, ...ingest.attachmentIds];
                } catch (err) {
                    return shapeFail(index, verb, err instanceof Error ? err.message : String(err));
                }
            }

            return {
                index,
                action: verb,
                preEvents,
                event: { ev: "comment", ...stamp(), text, ...(allIds.length > 0 ? { attachmentIds: allIds } : {}) },
            };
        }

        case "attach_file": {
            const path = typeof payload.path === "string" ? payload.path.trim() : "";

            if (path.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    'attach_file needs path — e.g. { action: "attach_file", path: "/tmp/screenshot.png", taskId: "t1", note: "before state" }.'
                );
            }

            try {
                const ingested = ingestAttachmentFromPath(handoff.id, path, deps.base);
                return {
                    index,
                    action: verb,
                    attachmentId: ingested.attachmentId,
                    event: {
                        ev: "attach",
                        ...stamp(),
                        attachmentId: ingested.attachmentId,
                        filename: ingested.filename,
                        mime: ingested.mime,
                        bytes: ingested.bytes,
                        ...(taskId !== undefined ? { taskId } : {}),
                        ...(typeof payload.note === "string" && payload.note.trim().length > 0
                            ? { note: payload.note }
                            : {}),
                    },
                };
            } catch (err) {
                return shapeFail(index, verb, err instanceof Error ? err.message : String(err));
            }
        }

        case "add_tasks": {
            const tasksRaw = payload.tasks;

            if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    'add_tasks needs tasks — e.g. { action: "add_tasks", tasks: [{ text: "Update the README", acceptanceCriteria: "section exists" }] }.'
                );
            }

            const tasks: HandoffTaskInput[] = [];

            for (const t of tasksRaw) {
                if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).text === "string") {
                    const item = t as Record<string, unknown>;
                    const task: HandoffTaskInput = { text: item.text as string };

                    if (typeof item.id === "string") {
                        task.id = item.id;
                    }

                    if (typeof item.acceptanceCriteria === "string") {
                        task.acceptanceCriteria = item.acceptanceCriteria;
                    }

                    tasks.push(task);
                }
            }

            if (tasks.length === 0) {
                return shapeFail(
                    index,
                    verb,
                    'add_tasks: every entry needs text — e.g. { action: "add_tasks", tasks: [{ text: "Update the README" }] }.'
                );
            }

            return { index, action: verb, event: { ev: "add_tasks", ...stamp(), tasks } };
        }

        case "modify_task": {
            const text = typeof payload.text === "string" && payload.text.trim().length > 0 ? payload.text : undefined;
            const acceptanceCriteria =
                typeof payload.acceptanceCriteria === "string" ? payload.acceptanceCriteria : undefined;

            if (taskId === undefined || (text === undefined && acceptanceCriteria === undefined)) {
                return shapeFail(
                    index,
                    verb,
                    'modify_task needs taskId plus text and/or acceptanceCriteria — e.g. { action: "modify_task", taskId: "t1", text: "…" }. Task status fields have their own verbs (check_task, deny_task, …).'
                );
            }

            const shapeInfo: string[] = [];

            for (const field of PROTECTED_TASK_FIELDS) {
                if (field in payload) {
                    shapeInfo.push(
                        `Protected field ignored: ${field} — mutable only via its own verb (§check_task/deny_task family).`
                    );
                }
            }

            return {
                index,
                action: verb,
                shapeInfo,
                event: {
                    ev: "modify_task",
                    ...stamp(),
                    taskId,
                    ...(text !== undefined ? { text } : {}),
                    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
                },
            };
        }

        case "modify_handoff": {
            const title =
                typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title : undefined;
            const description = typeof payload.description === "string" ? payload.description : undefined;
            const target =
                payload.target === null
                    ? null
                    : payload.target !== null && typeof payload.target === "object"
                      ? (payload.target as HandoffTarget)
                      : undefined;
            const refs = asStringArray(payload.refs);

            if (title === undefined && description === undefined && target === undefined && refs === undefined) {
                return shapeFail(
                    index,
                    verb,
                    'modify_handoff needs at least one of title/description/target/refs — e.g. { action: "modify_handoff", title: "…" }. Tasks are edited via modify_task/add_tasks.'
                );
            }

            return {
                index,
                action: verb,
                event: {
                    ev: "modify_handoff",
                    ...stamp(),
                    ...(title !== undefined ? { title } : {}),
                    ...(description !== undefined ? { description } : {}),
                    ...(target !== undefined ? { target } : {}),
                    ...(refs !== undefined ? { refs } : {}),
                },
            };
        }

        case "finish_handoff":
            return {
                index,
                action: verb,
                event: { ev: "finish", ...stamp(), ...(payload.force === true ? { force: true } : {}) },
            };

        case "cancel_handoff":
            return { index, action: verb, event: { ev: "cancel", ...stamp() } };

        case "reopen_handoff":
            return { index, action: verb, event: { ev: "reopen", ...stamp() } };

        default:
            return shapeFail(index, verb, `Unknown action "${requested}". ${VERB_CATALOG}`);
    }
}

// ---------------------------------------------------------------------------
// Dashboard helpers (routes share this executor — §7.2)
// ---------------------------------------------------------------------------

export interface AttachBytesInput {
    id: string;
    filename: string;
    bytes: Uint8Array;
    taskId?: string;
    note?: string;
}

export interface AttachBytesResponse {
    attachmentId: string;
    handoff: PublicHandoff;
    info: string[];
}

/** The dashboard /attach route: pasted/dropped bytes → store + attach event. */
export function attachHandoffBytes(input: AttachBytesInput, deps: HandoffDeps = {}): AttachBytesResponse {
    const id = normalizeHandoffId(String(input.id ?? ""));
    const by = buildBy(deps);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const existing = getHandoffById(db, id);

        if (existing === null) {
            throw new Error(`No handoff ${id} — re-check the paste block or call handoff_list to find it.`);
        }

        const ingested = ingestAttachmentBytes(id, input.filename, input.bytes, deps.base);
        const event: HandoffEvent = {
            ev: "attach",
            ts: nowIso(deps),
            uid: generateEventUid(),
            id,
            by,
            attachmentId: ingested.attachmentId,
            filename: ingested.filename,
            mime: ingested.mime,
            bytes: ingested.bytes,
            ...(input.taskId !== undefined && input.taskId.length > 0 ? { taskId: input.taskId } : {}),
            ...(input.note !== undefined && input.note.length > 0 ? { note: input.note } : {}),
        };
        appendHandoffEvents([event], deps.base);
        catchUpHandoffs(db, deps.base);
        const outcome = getEventOutcome(db, event.uid);

        if (outcome !== null && !outcome.applied) {
            throw new Error(outcome.error ?? "attach rejected by fold");
        }

        const handoff = getHandoffById(db, id);

        if (handoff === null) {
            throw new Error(`No handoff ${id} after fold — check ~/.genesis-tools/logs for details.`);
        }

        return {
            attachmentId: ingested.attachmentId,
            handoff: publicHandoff(handoff, deps.base),
            info: stateInfo(handoff, by),
        };
    });
}

export interface ResolvedAttachment {
    handoffId: string;
    attachmentId: string;
    filename: string;
    mime: string;
    path: string;
    missing: boolean;
}

/** Locate an attachment by id across handoffs (dashboard /attachment route). */
export function resolveAttachment(attachmentId: string, deps: HandoffDeps = {}): ResolvedAttachment | null {
    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const rows = db
            .query("SELECT id, attachments FROM handoffs WHERE attachments LIKE ?")
            .all(`%${attachmentId}%`) as { id: string; attachments: string }[];

        for (const row of rows) {
            const attachments = SafeJSON.parse(row.attachments, { strict: true }) as Handoff["attachments"];
            const found = attachments.find((a) => a.attachmentId === attachmentId);

            if (found !== undefined) {
                return {
                    handoffId: row.id,
                    attachmentId,
                    filename: found.filename,
                    mime: found.mime,
                    path: attachmentFilePath(row.id, attachmentId, found.filename, deps.base),
                    missing: found.missing === true,
                };
            }
        }

        return null;
    });
}
