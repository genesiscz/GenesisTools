import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { attachmentFilePath, ingestAttachmentBytes, ingestAttachmentFromPath } from "./attachments";
import { applyHandoffEvent, targetMatchesSession } from "./fold";
import { generateEditId, generateEventUid, generateHandoffId, normalizeEditId, normalizeHandoffId } from "./ids";
import { type ProjectedHandoff, parseIncludeSections, projectHandoff } from "./project";
import { resolveHandoffProject } from "./project-ref";
import {
    catchUpHandoffs,
    commitHandoffEvents,
    findHandoffsByName,
    getEventOutcome,
    getHandoffById,
    listHandoffEvents,
    listHandoffRows,
} from "./read-model";
import {
    buildBy,
    type GetClaim,
    HandoffReader,
    isClaimedBy,
    type PublicHandoff,
    publicHandoff,
    resolveHandoffRef as resolveRef,
    stateInfo,
    withDb,
} from "./reader";
import {
    canonicalAgent,
    HANDOFF_AGENTS_LIST,
    type HandoffAgent,
    handoffNameFor,
    isKnownAgent,
    normalizeHandoffName,
    normalizeTargetInput,
    recipientCheck,
} from "./targeting";
import type {
    Handoff,
    HandoffActionInput,
    HandoffActionResult,
    HandoffEvent,
    HandoffEventBy,
    HandoffProof,
    HandoffPublicEvent,
    HandoffTarget,
    HandoffTaskInput,
} from "./types";

const log = logger.child({ component: "handoff:executor" });

export interface HandoffDeps {
    /** Log + attachment store base dir override (tests). */
    base?: string;
    /** Work database path override (tests). */
    dbPath?: string;
    /** AgentRuntimeContext overrides (tests / explicit session). */
    ctx?: Partial<AgentRuntimeContext>;
    /** Full actor override — the dashboard's owner-authority human actor (§7.1). */
    by?: HandoffEventBy;
    nowIso?: () => string;
    /** Stable ID of one legacy action from a pending Work request. */
    workOperationId?: string;
    /** When this returns a link, handoff_post offers a one-click cmux launch. Null means the preset is off. */
    linkFor?: (presetId: string) => { url: string; markdown: string } | null;
    mintLaunchLink?: (input: {
        name: string;
        prompt: string;
        cwd: string | null;
        account?: string | null;
    }) => { url: string; markdown: string } | null;
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

/** The poster credential of a handoff, for a write the owner makes through the work store. */
export function posterEditId(id: string, deps: HandoffDeps = {}): string | undefined {
    return withDb(deps, (db) => getHandoffById(db, id)?.editId);
}

function nowIso(deps: HandoffDeps): string {
    return deps.nowIso !== undefined ? deps.nowIso() : new Date().toISOString();
}

function pasteAgentText(id: string): string {
    return (
        `You have been handed a task list. Call the genesis-tools MCP tool handoff_get with { id: "${id}" } to read it, ` +
        "then check its `warnings` — if it says the handoff is addressed to another session or harness, stop and ask your user before working it. " +
        `then claim it by calling handoff_get again with { id: "${id}", claim: true } before working. ` +
        'Check each finished task off with handoff_action { id, actions: [{ action: "check_task", taskId, proof: { answer, commitIds } }] }. ' +
        'To refuse a task you can\'t do, send { action: "deny_task", taskId, reason }. ' +
        'When every task is checked or denied, send { action: "finish_handoff" }. ' +
        "If the id doesn't resolve, call handoff_list to find it. " +
        "If you don't have the genesis-tools MCP tools, tell your user to enable the genesis-tools MCP server."
    );
}

const legacyQueries = { getHandoffById, findHandoffsByName, listHandoffRows, listHandoffEvents };

function resolveHandoffRef(db: Database, input: { id?: string; name?: string }): Handoff {
    return resolveRef({ db, input, queries: legacyQueries });
}

// ---------------------------------------------------------------------------
// handoff_post
// ---------------------------------------------------------------------------

export interface PostHandoffInput {
    title: string;
    /** Readable slug this handoff can also be fetched by. Defaults to a slug of the title. */
    name?: string;
    description?: string;
    tasks: HandoffTaskInput[];
    target?: HandoffTarget;
    refs?: string[];
    /**
     * The project the handoff is FOR: a project name, or a repository path resolved to its project.
     * Wins over the poster's working folder, which `postedByContext` still records.
     */
    project?: string;
}

export interface PostHandoffResponse {
    handoff: PublicHandoff;
    editId: string;
    paste: {
        _agent: string;
        id: string;
        title: string;
        tasks: string;
        name?: string;
        runLink?: { url: string; markdown: string };
    };
    info: string[];
}

/**
 * Where a launch from this actor opens: the checkout it posted from. In a linked worktree
 * `repoRoot` names the MAIN checkout, so the worktree's own cwd is the one to use.
 */
export function launchCwd(by: Pick<HandoffEventBy, "cwd" | "repoRoot" | "isWorktree">): string | null {
    return by.isWorktree ? (by.cwd ?? by.repoRoot) : (by.repoRoot ?? by.cwd);
}

/** The harness the run link starts: a `cmux-claude` launch of `tools claude run auto`. */
const LAUNCH_LINK_AGENT: HandoffAgent = "claude";

/** `cwd` comes from the RESOLVED actor, so the link opens in the handoff's checkout even with default deps. */
function mintHandoffLaunch({
    name,
    prompt,
    cwd,
    deps,
}: {
    name: string;
    prompt: string;
    cwd: string | null;
    deps: HandoffDeps;
}): { url: string; markdown: string } | null {
    if (!deps.linkFor || deps.linkFor("cmux-claude") === null) {
        return null;
    }

    return (
        deps.mintLaunchLink?.({
            name: `handoff ${name}`,
            prompt,
            cwd,
            // Picked when the link is clicked: `tools claude run auto` takes the account with the most headroom.
            account: "auto",
        }) ?? null
    );
}

function workEventUid(operationId: string, index: number): string {
    return createHash("sha256").update(operationId).update(`:${index}`).digest("hex").slice(0, 24);
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

    const named = input.project !== undefined ? resolveHandoffProject(input.project) : null;
    const by = buildBy(deps);
    const event: HandoffEvent = {
        ev: "post",
        ts: nowIso(deps),
        uid: deps.workOperationId === undefined ? generateEventUid() : workEventUid(deps.workOperationId, 0),
        id: generateHandoffId(),
        editId: generateEditId(),
        title,
        tasks,
        by,
    };
    const name = handoffNameFor({ name: input.name, title });

    if (name !== undefined) {
        event.name = name;
    }

    if (input.description !== undefined && input.description.trim().length > 0) {
        event.description = input.description;
    }

    const target = normalizeTargetInput(input.target);

    if (target !== undefined) {
        event.target = target;
    }

    if (input.refs !== undefined && input.refs.length > 0) {
        event.refs = input.refs;
    }

    if (named !== null) {
        event.project = named.project;
    }

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const applied =
            deps.workOperationId === undefined
                ? null
                : db
                      .query<{ handoff_id: string }, [string]>(
                          "SELECT handoff_id FROM handoff_event_results WHERE uid = ? AND ok = 1"
                      )
                      .get(event.uid);

        if (applied === null) {
            commitHandoffEvents(db, [event], deps.base);
        }

        const handoff = getHandoffById(db, applied?.handoff_id ?? event.id);

        if (handoff === null) {
            throw new Error(`handoff_post failed to fold ${event.id} — check ~/.genesis-tools/logs for details.`);
        }

        log.info(
            {
                id: handoff.id,
                name: handoff.name,
                tasks: handoff.tasks.length,
                by: by.sessionId,
                targetAgent: target?.agent,
                project: handoff.project,
                posterProject: by.project,
            },
            "handoff posted"
        );

        const info = [
            "Posted. Copy `paste` into the target agent's chat.",
            "You can edit from this session anytime via handoff_action (no editId needed).",
        ];

        if (handoff.name !== undefined) {
            // A title-derived name can already be taken; promising a lookup that will be refused as ambiguous helps nobody.
            const clashes = findHandoffsByName(db, handoff.name).filter((h) => h.id !== handoff.id);
            info.push(
                clashes.length === 0
                    ? `Readable name: "${handoff.name}" — receivers can also call handoff_get { name: "${handoff.name}" }.`
                    : `Readable name "${handoff.name}" is already carried by ${clashes.map((h) => h.id).join(", ")} — handoff_get { name } will be refused as ambiguous. Hand out the id, or rename via handoff_action modify_handoff { name }.`
            );
        }

        // The link starts a CLAUDE session, so it is offered only when Claude may work the handoff:
        // no target harness, or Claude. A Codex or Grok target would get a session its own paste
        // text tells to stop.
        const targetAgent = handoff.target?.agent;
        const targetCwd =
            named === null || named.project === by.project ? (named?.launchCwd ?? launchCwd(by)) : named.launchCwd;
        const runLink =
            (targetAgent === undefined || canonicalAgent(targetAgent) === LAUNCH_LINK_AGENT) &&
            (named === null || targetCwd !== null)
                ? mintHandoffLaunch({
                      name: handoff.name ?? handoff.id,
                      prompt: pasteAgentText(handoff.id),
                      cwd: targetCwd,
                      deps,
                  })
                : null;

        if (runLink) {
            info.push("Show paste.runLink.markdown to the user so they can open the handoff in a new cmux surface.");
        }

        if (target?.agent !== undefined && !isKnownAgent(target.agent)) {
            info.push(
                `target.agent "${target.agent}" is not a documented harness (${HANDOFF_AGENTS_LIST}) — it is stored as given, but no recipient warning can ever fire for it.`
            );
        }

        return {
            handoff: publicHandoff(handoff, deps.base),
            editId: event.editId,
            paste: {
                _agent: pasteAgentText(handoff.id),
                id: handoff.id,
                title: handoff.title,
                tasks: `0/${handoff.tasks.length}`,
                ...(handoff.name !== undefined ? { name: handoff.name } : {}),
                ...(runLink ? { runLink } : {}),
            },
            info,
        };
    });
}

/** A get may claim or unclaim. These writes must still go through the fold and its log echo. */
export function applyGetClaim({ db, existing, by, input, deps, recipientAgent }: GetClaim): string[] {
    const id = existing.id;
    const events: HandoffEvent[] = [];
    const extraInfo: string[] = [];
    let autoClaimUid: string | undefined;
    let claimUid: string | undefined;
    let unclaimUid: string | undefined;

    const addressedToThisSession =
        existing.target?.sessionId !== undefined &&
        targetMatchesSession(existing.target.sessionId, by.sessionId) &&
        !isClaimedBy(existing, by) &&
        (existing.status === "open" || existing.status === "claimed");

    // A session-id hit under a harness the handoff is NOT addressed to must not
    // claim silently: the poster named two recipients and only one of them is us.
    const autoClaim = input.unclaim !== true && addressedToThisSession && recipientAgent !== "mismatch";

    if (input.unclaim !== true && addressedToThisSession && recipientAgent === "mismatch") {
        extraInfo.push(
            `NOT auto-claimed: the target sessionId names this session, but the handoff is addressed to harness "${existing.target?.agent}". Claim explicitly only if your user asks you to.`
        );
    }

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
        commitHandoffEvents(db, events, deps.base);
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

    return extraInfo;
}

const legacyReader = new HandoffReader(legacyQueries, applyGetClaim);
export const getHandoff = legacyReader.getHandoff.bind(legacyReader);
export const listHandoffs = legacyReader.listHandoffs.bind(legacyReader);
export type {
    GetHandoffFullResponse,
    GetHandoffInput,
    GetHandoffResponse,
    GetHandoffScopedResponse,
    HandoffTaskPreview,
    ListHandoffsInput,
    ListHandoffsResponse,
    PublicHandoff,
} from "./reader";

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
    /** Handoff id, or a readable name — both resolve here. */
    id?: string;
    /** Readable name, when you would rather not overload `id`. */
    name?: string;
    editId?: string;
    actions: HandoffActionInput[];
    /** MCP section scoping. Omit → full PublicHandoff (HTTP). MCP handlers default to ["tasks"]. */
    include?: string[];
}

export type ExecuteActionsFullResponse = {
    handoff: PublicHandoff;
    results: HandoffActionResult[];
    info: string[];
    /** Recipient warnings for the CALLING session — absent when there is nothing to say. */
    warnings?: string[];
};

export type ExecuteActionsScopedResponse = {
    handoff: ProjectedHandoff;
    results: HandoffActionResult[];
    info: string[];
    warnings?: string[];
};

export type ExecuteActionsResponse = ExecuteActionsFullResponse | ExecuteActionsScopedResponse;

export function executeHandoffActions(
    input: ExecuteActionsInput & { include: string[] },
    deps?: HandoffDeps
): ExecuteActionsScopedResponse;
export function executeHandoffActions(
    input: Omit<ExecuteActionsInput, "include">,
    deps?: HandoffDeps
): ExecuteActionsFullResponse;
export function executeHandoffActions(input: ExecuteActionsInput, deps: HandoffDeps = {}): ExecuteActionsResponse {
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
        throw new Error(
            'handoff_action needs an actions array — e.g. handoff_action { id: "h_x1y2z3ab", actions: [{ action: "check_task", taskId: "t1", proof: { answer: "…" } }] }. ' +
                VERB_CATALOG
        );
    }

    const requested = input.include !== undefined ? parseIncludeSections(input.include) : null;
    const sections = requested?.includes("full") ? null : requested;
    const editId = normalizeEditId(input.editId);
    const by = buildBy(deps);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const existing = resolveHandoffRef(db, input);
        const id = existing.id;

        let eventIndex = 0;
        const stamp = (): { ts: string; uid: string; id: string; by: HandoffEventBy; editId?: string } => ({
            ts: nowIso(deps),
            uid:
                deps.workOperationId === undefined
                    ? generateEventUid()
                    : workEventUid(deps.workOperationId, eventIndex++),
            id,
            by,
            ...(editId !== undefined ? { editId } : {}),
        });

        const pending: PendingAction[] = input.actions.map((raw, index) =>
            parseAction(raw, index, existing, stamp, deps)
        );

        const events = pending.flatMap((p) => [...(p.preEvents ?? []), ...(p.event !== undefined ? [p.event] : [])]);

        const unfinished =
            deps.workOperationId === undefined
                ? events
                : events.filter((event) => getEventOutcome(db, event.uid) === null);

        if (unfinished.length > 0) {
            commitHandoffEvents(db, unfinished, deps.base);
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

        // Checked against the FOLDED target: a modify_handoff that retargets in this
        // batch must produce (or clear) the warning in this same response.
        const recipient = recipientCheck({ target: handoff.target, by });
        const full = publicHandoff(handoff, deps.base);
        let projectedEvents: HandoffPublicEvent[] | undefined;

        if (sections?.includes("events")) {
            projectedEvents = listHandoffEvents({ db, handoffId: id }).events;
        }

        return {
            handoff: sections === null ? full : projectHandoff({ handoff: full, sections, events: projectedEvents }),
            results,
            info: stateInfo(handoff, by),
            ...(recipient.warnings.length > 0 ? { warnings: recipient.warnings } : {}),
        } as ExecuteActionsResponse;
    });
}

/**
 * What `executeHandoffActions` would answer to each batch, folded in memory on the current state: nothing is written.
 * The work store asks this before it commits a write it will copy into the old log, so a write the old log refuses
 * never stays in the store (spec P6, the 14 days of double writing). Batches on the same handoff fold one after
 * the other, as they would be written.
 */
export function checkHandoffActions(
    batches: { id: string; editId?: string; actions: HandoffActionInput[] }[],
    deps: HandoffDeps = {}
): HandoffActionResult[][] {
    const by = buildBy(deps);

    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        const states = new Map<string, Handoff>();

        return batches.map((batch) => {
            const resolved = resolveHandoffRef(db, { id: batch.id });
            let state = states.get(resolved.id) ?? resolved;
            const editId = normalizeEditId(batch.editId);
            const stamp = (): { ts: string; uid: string; id: string; by: HandoffEventBy; editId?: string } => ({
                ts: nowIso(deps),
                uid: generateEventUid(),
                id: state.id,
                by,
                ...(editId !== undefined ? { editId } : {}),
            });

            const results = batch.actions.map((raw, index): HandoffActionResult => {
                const pending = parseAction(raw, index, state, stamp, deps);

                if (pending.result !== undefined) {
                    return pending.result;
                }

                let outcome: { applied: boolean; error?: string } = {
                    applied: false,
                    error: "internal: no event built",
                };

                for (const event of [...(pending.preEvents ?? []), ...(pending.event ? [pending.event] : [])]) {
                    const folded = applyHandoffEvent(state, event, { base: deps.base });

                    if (folded.outcome.applied && folded.state !== null) {
                        state = folded.state;
                    }

                    if (event === pending.event) {
                        outcome = folded.outcome;
                    }
                }

                return {
                    action: pending.action,
                    ok: outcome.applied,
                    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
                };
            });

            states.set(state.id, state);
            return results;
        });
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
                    'attach_file needs path — e.g. { action: "attach_file", path: "/path/to/screenshot.png", taskId: "t1", note: "before state" }.'
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

                    if (typeof item.item === "string") {
                        task.item = item.item;
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
            // An object that carries nothing usable clears the target, same as null.
            const target =
                payload.target === null
                    ? null
                    : payload.target !== undefined && typeof payload.target === "object"
                      ? (normalizeTargetInput(payload.target) ?? null)
                      : undefined;
            const refs = asStringArray(payload.refs);
            let project: string | undefined;

            if ("project" in payload) {
                try {
                    project = resolveHandoffProject(payload.project, "modify_handoff: project").project;
                } catch (error) {
                    return shapeFail(index, verb, error instanceof Error ? error.message : String(error));
                }
            }

            let name: string | null | undefined;

            if ("name" in payload) {
                if (payload.name === null || (typeof payload.name === "string" && payload.name.trim().length === 0)) {
                    name = null;
                } else if (typeof payload.name !== "string") {
                    return shapeFail(
                        index,
                        verb,
                        'modify_handoff: name must be a string, or null to clear it — e.g. { action: "modify_handoff", name: "fix-active-filter" }.'
                    );
                } else {
                    const slug = normalizeHandoffName(payload.name);

                    if (slug === undefined) {
                        return shapeFail(
                            index,
                            verb,
                            `modify_handoff: name "${payload.name}" has no letters or digits to build a name from — try something like "fix-active-filter".`
                        );
                    }

                    name = slug;
                }
            }

            if (
                title === undefined &&
                name === undefined &&
                description === undefined &&
                target === undefined &&
                refs === undefined &&
                project === undefined
            ) {
                return shapeFail(
                    index,
                    verb,
                    'modify_handoff needs at least one of title/name/description/target/refs/project — e.g. { action: "modify_handoff", title: "…" }. Tasks are edited via modify_task/add_tasks.'
                );
            }

            return {
                index,
                action: verb,
                event: {
                    ev: "modify_handoff",
                    ...stamp(),
                    ...(title !== undefined ? { title } : {}),
                    ...(name !== undefined ? { name } : {}),
                    ...(description !== undefined ? { description } : {}),
                    ...(target !== undefined ? { target } : {}),
                    ...(refs !== undefined ? { refs } : {}),
                    ...(project !== undefined ? { project } : {}),
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
        commitHandoffEvents(db, [event], deps.base);
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
            let attachments: Handoff["attachments"];
            try {
                attachments = SafeJSON.parse(row.attachments, { strict: true }) as Handoff["attachments"];
            } catch (err) {
                log.warn({ err, handoffId: row.id }, "handoff.attachments column is not valid JSON — skipping");
                continue;
            }

            if (!Array.isArray(attachments)) {
                log.warn({ handoffId: row.id }, "handoff.attachments column is not an array — skipping");
                continue;
            }

            const found = attachments.find(
                (a) => a !== null && typeof a === "object" && a.attachmentId === attachmentId
            );

            if (found !== undefined) {
                if (typeof found.filename !== "string" || typeof found.mime !== "string") {
                    log.warn(
                        { handoffId: row.id, attachmentId },
                        "attachment entry missing string filename/mime — skipping"
                    );
                    continue;
                }

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
