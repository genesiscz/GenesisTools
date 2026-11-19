import type { Database } from "bun:sqlite";
import { STAMP_FACETS, whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { toRuntimeContext } from "@genesiscz/utils/agent/identity";
import type { handoffQueries } from "@genesiscz/utils/work/legacy/handoff-read";
import { attachmentFilePath } from "./attachments";
import type { HandoffDeps } from "./executor";
import { CANCELLED_INFO, claimMatches, DONE_INFO, isHumanOwner, sessionIdMatches, targetMatchesSession } from "./fold";
import { normalizeHandoffId } from "./ids";
import { isEventsOnlyInclude, type ProjectedHandoff, parseIncludeSections, projectHandoff } from "./project";
import { catchUpHandoffs, openHandoffModel } from "./read-model";
import {
    agentFilterMatches,
    HANDOFF_AGENTS_LIST,
    isKnownAgent,
    normalizeHandoffName,
    type RecipientStatus,
    recipientCheck,
    sessionFilterMatches,
} from "./targeting";
import type { Handoff, HandoffEventBy, HandoffListRow, HandoffPublicEvent } from "./types";

type HandoffQueries = typeof handoffQueries;

export interface GetClaim {
    db: Database;
    existing: Handoff;
    by: HandoffEventBy;
    input: GetHandoffInput;
    deps: HandoffDeps;
    recipientAgent: RecipientStatus;
}

export function buildBy(deps: HandoffDeps): HandoffEventBy {
    if (deps.by !== undefined) {
        return deps.by;
    }

    const ctx = toRuntimeContext(whoIsCallingHere({ facets: STAMP_FACETS, overrides: deps.ctx }));
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

export function withDb<T>(deps: HandoffDeps, fn: (db: Database) => T): T {
    const db = openHandoffModel(deps.dbPath);

    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** Older producers may have appended only to the day file. Fold their tail before reading work.db. */
export function withHandoffReadDb<T>(deps: HandoffDeps, read: (db: Database) => T): T {
    return withDb(deps, (db) => {
        catchUpHandoffs(db, deps.base);
        return read(db);
    });
}

/** The response-facing handoff: editId stripped (returned separately, only when entitled). */
export type PublicHandoff = Omit<Handoff, "editId"> & {
    attachments: (Handoff["attachments"][number] & { path?: string })[];
};

export function publicHandoff(h: Handoff, base?: string): PublicHandoff {
    const { editId: _editId, ...rest } = h;
    return {
        ...rest,
        attachments: h.attachments.map((a) =>
            a.missing === true ? { ...a } : { ...a, path: attachmentFilePath(h.id, a.attachmentId, a.filename, base) }
        ),
    };
}

export function isClaimedBy(h: Handoff, by: HandoffEventBy): boolean {
    return h.claimedBy.some((c) => claimMatches(c, by));
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
export function stateInfo(h: Handoff, by: HandoffEventBy): string[] {
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

const REF_REQUIRED =
    'Pass id or name — e.g. handoff_get { id: "h_x1y2z3ab" } or handoff_get { name: "fix-active-filter" }.';

/**
 * Resolve a handoff from an id, a readable name, or an `id` field that holds
 * either. Deterministic on purpose: an id always wins, a unique name resolves,
 * and an ambiguous name is refused WITH its candidates. Picking the newest of
 * several same-named handoffs would silently work the wrong one.
 */
export function resolveHandoffRef({
    db,
    input,
    queries,
}: {
    db: Database;
    input: { id?: string; name?: string };
    queries: Pick<HandoffQueries, "getHandoffById" | "findHandoffsByName">;
}): Handoff {
    const rawId = typeof input.id === "string" ? input.id.trim() : "";
    const rawName = typeof input.name === "string" ? input.name.trim() : "";

    if (rawId.length === 0 && rawName.length === 0) {
        throw new Error(REF_REQUIRED);
    }

    const byId = rawId.length > 0 ? queries.getHandoffById(db, normalizeHandoffId(rawId)) : null;

    if (byId !== null) {
        const wanted = normalizeHandoffName(rawName);

        if (wanted !== undefined && byId.name !== wanted) {
            throw new Error(
                `The id and the name point at different handoffs: ${byId.id} is called "${byId.name ?? "(unnamed)"}", not "${wanted}". Pass one of them, not both.`
            );
        }

        return byId;
    }

    // An `h_`-prefixed value is an id claim (no slug can carry an underscore). Beside a
    // name it must resolve as an id: a stale id never falls back to whatever the name finds.
    if (rawId.startsWith("h_") && rawName.length > 0) {
        throw new Error(
            `No handoff ${rawId} — the id does not resolve, so the name "${rawName}" is not used. Re-call with just the one you mean.`
        );
    }

    // The `id` field also accepts a name, so a paste of either resolves.
    const lookup = normalizeHandoffName(rawName.length > 0 ? rawName : rawId);
    const matches = lookup !== undefined ? queries.findHandoffsByName(db, lookup) : [];

    if (matches.length === 1) {
        // Both fields were names: the one not used for the lookup must name the same handoff.
        const other = rawName.length > 0 && rawId.length > 0 ? normalizeHandoffName(rawId) : undefined;

        if (other !== undefined && other !== lookup) {
            throw new Error(
                `The id and the name point at different handoffs: "${rawId}" is not "${lookup}". Pass one of them, not both.`
            );
        }

        return matches[0];
    }

    if (matches.length > 1) {
        const candidates = matches.map((h) => `${h.id} (${h.status}, updated ${h.updatedTs}) "${h.title}"`).join("; ");
        throw new Error(
            `Name "${lookup}" is ambiguous — ${matches.length} handoffs carry it: ${candidates}. Re-call with the id of the one you mean.`
        );
    }

    if (rawId.length > 0) {
        throw new Error(
            `No handoff ${normalizeHandoffId(rawId)} — re-check the paste block or call handoff_list to find it.`
        );
    }

    throw new Error(`No handoff named "${lookup ?? rawName}" — call handoff_list to see what exists.`);
}

export interface GetHandoffInput {
    /** Handoff id, or a readable name — both resolve here. */
    id?: string;
    /** Readable name, when you would rather not overload `id`. */
    name?: string;
    claim?: boolean;
    unclaim?: boolean;
    /** MCP section scoping. Omit → full PublicHandoff (HTTP). The MCP get adapter defaults to ["rows"]. */
    include?: string[];
}

export type GetHandoffFullResponse = {
    handoff: PublicHandoff;
    editId?: string;
    info: string[];
    /** Recipient warnings for the CALLING session — absent when there is nothing to say. */
    warnings?: string[];
};

export type GetHandoffScopedResponse =
    | {
          handoff: ProjectedHandoff;
          editId?: string;
          info: string[];
          warnings?: string[];
      }
    | {
          events: HandoffPublicEvent[];
          info: string[];
          warnings?: string[];
      };

export type GetHandoffResponse = GetHandoffFullResponse | GetHandoffScopedResponse;

export interface ListHandoffsInput {
    limit?: number;
    offset?: number;
    mine?: boolean;
    open?: boolean;
    project?: string;
    /** Opt-in: only handoffs whose INTENDED RECIPIENT harness is this one. Never the poster's. */
    agent?: string;
    /** Opt-in: only handoffs whose INTENDED RECIPIENT session is this id (or abbreviation) or name. */
    session?: string;
    /** Only `"tasks"` is honored on list rows; other values no-op with an info line. */
    include?: string[];
}

/**
 * A task as it appears on a LIST row: the proof is a preview, never the whole
 * thing. `answer` may be clipped, `context` is always dropped, and the id
 * arrays hold at most the first few entries. Call handoff_get for the stored
 * proof — treating this shape as complete loses evidence.
 */
export type HandoffTaskPreview = Omit<Handoff["tasks"][number], "proof"> & {
    proof?: Omit<NonNullable<Handoff["tasks"][number]["proof"]>, "context"> & { context?: undefined };
};

export interface ListHandoffsResponse {
    handoffs: (HandoffListRow & { taskList?: HandoffTaskPreview[] })[];
    info: string[];
}

const PROOF_PREVIEW_CHARS = 200;
const PROOF_PREVIEW_IDS = 5;

export class HandoffReader {
    constructor(
        private readonly queries: HandoffQueries,
        private readonly applyClaim: (claim: GetClaim) => string[]
    ) {}

    getHandoff(input: GetHandoffInput & { include: string[] }, deps?: HandoffDeps): GetHandoffScopedResponse;
    getHandoff(input: Omit<GetHandoffInput, "include">, deps?: HandoffDeps): GetHandoffFullResponse;
    getHandoff(input: GetHandoffInput, deps: HandoffDeps = {}): GetHandoffResponse {
        if (input.claim === true && input.unclaim === true) {
            throw new Error(
                `Pass either claim: true or unclaim: true, not both — e.g. handoff_get { id: "${input.id ?? input.name}", claim: true }.`
            );
        }

        const parsed = input.include !== undefined ? parseIncludeSections(input.include) : null;
        // include ["full"] is the old whole shape, the same as no include at all.
        const sections = parsed?.includes("full") ? null : parsed;
        const by = buildBy(deps);

        return withHandoffReadDb(deps, (db) => {
            const existing = resolveHandoffRef({ db, input, queries: this.queries });
            const id = existing.id;
            const recipient = recipientCheck({ target: existing.target, by });

            const extraInfo = this.applyClaim({ db, existing, by, input, deps, recipientAgent: recipient.agent });
            const handoff = this.queries.getHandoffById(db, id);
            if (handoff === null) {
                throw new Error(`No handoff ${id} — re-check the paste block or call handoff_list to find it.`);
            }

            const info = [...extraInfo, ...stateInfo(handoff, by)];
            const warnings = recipient.warnings.length > 0 ? { warnings: recipient.warnings } : {};

            if (sections?.includes("rows") && !sections.includes("tasks")) {
                info.push(
                    'Compact view: include ["description"] adds the body, ["tasks"] the proofs, ["full"] the whole handoff.'
                );
            }

            if (sections !== null && isEventsOnlyInclude(sections)) {
                const { events: publicEvents } = this.queries.listHandoffEvents({ db, handoffId: id });
                return { events: publicEvents, info, ...warnings };
            }

            const full = publicHandoff(handoff, deps.base);
            let projectedEvents: HandoffPublicEvent[] | undefined;

            if (sections?.includes("events")) {
                projectedEvents = this.queries.listHandoffEvents({ db, handoffId: id }).events;
            }

            const credential = isPosterSession(handoff, by) || isHumanOwner(by) ? { editId: handoff.editId } : {};
            const fields = { info, ...warnings, ...credential };
            return sections === null
                ? { handoff: full, ...fields }
                : { handoff: projectHandoff({ handoff: full, sections, events: projectedEvents }), ...fields };
        });
    }

    listHandoffs(input: ListHandoffsInput = {}, deps: HandoffDeps = {}): ListHandoffsResponse {
        const by = buildBy(deps);
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
            throw new Error("limit must be a positive integer.");
        }

        if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) {
            throw new Error("offset must be a nonnegative integer.");
        }

        const limit = input.limit ?? 20;
        const offset = input.offset !== undefined && input.offset > 0 ? input.offset : 0;
        const sections = input.include !== undefined ? parseIncludeSections(input.include) : [];
        const wantTasks = sections.includes("tasks");
        const ignored = sections.filter((s) => s !== "tasks");

        return withHandoffReadDb(deps, (db) => {
            let rows = this.queries.listHandoffRows(db, {
                statuses: input.open === true ? ["open", "claimed"] : undefined,
                project: input.project,
            });

            if (input.mine === true) {
                rows = rows.filter(
                    (h) =>
                        isPosterSession(h, by) ||
                        isClaimedBy(h, by) ||
                        targetMatchesSession(h.target?.sessionId ?? null, by.sessionId) ||
                        (h.target?.sessionName != null &&
                            by.sessionTitle != null &&
                            h.target.sessionName === by.sessionTitle)
                );
            }

            // Opt-in only: with neither flag the listing stays exactly what it was.
            const agentFilter =
                input.agent !== undefined && input.agent.trim().length > 0 ? input.agent.trim() : undefined;
            const sessionFilter =
                input.session !== undefined && input.session.trim().length > 0 ? input.session.trim() : undefined;

            if (agentFilter !== undefined) {
                rows = rows.filter((h) => agentFilterMatches(h.target, agentFilter));
            }

            if (sessionFilter !== undefined) {
                rows = rows.filter((h) => sessionFilterMatches(h.target, sessionFilter));
            }

            const total = rows.length;
            const page = rows.slice(offset, offset + limit);
            const now = Date.now();
            let proofsClipped = false;
            const handoffs = page.map((h): HandoffListRow & { taskList?: HandoffTaskPreview[] } => {
                const p = progress(h);
                const row: HandoffListRow & { taskList?: HandoffTaskPreview[] } = {
                    id: h.id,
                    title: h.title,
                    status: h.status,
                    tasks: `${p.resolved}/${p.total}`,
                    postedBy: { sessionName: h.postedBy.sessionName },
                    project: h.project,
                    ageHours: Math.round(((now - new Date(h.createdTs).getTime()) / 3_600_000) * 10) / 10,
                };

                if (h.name !== undefined) {
                    row.name = h.name;
                }

                if (h.target !== undefined) {
                    row.target = h.target;
                    const recipient = recipientCheck({ target: h.target, by });

                    if (recipient.warnings.length > 0) {
                        row.warnings = recipient.warnings;
                    }
                }

                if (h.claimedBy.length > 0) {
                    row.claimedBy = h.claimedBy.map((c) => ({ sessionId: c.sessionId, sessionName: c.sessionName }));
                    row.progress = `${p.resolved}/${p.total}${p.denied > 0 ? ` (${p.denied} denied)` : ""}`;
                }

                if (wantTasks) {
                    // List rows carry a proof preview; get returns the stored proof.
                    row.taskList = h.tasks.map((task): HandoffTaskPreview => {
                        if (task.proof === undefined) {
                            return { ...task, proof: undefined };
                        }

                        const clipped = task.proof.answer.length > PROOF_PREVIEW_CHARS;
                        const idsClipped =
                            (task.proof.commitIds?.length ?? 0) > PROOF_PREVIEW_IDS ||
                            (task.proof.attachmentIds?.length ?? 0) > PROOF_PREVIEW_IDS;
                        proofsClipped ||= clipped || idsClipped || task.proof.context !== undefined;
                        return {
                            ...task,
                            proof: {
                                ...task.proof,
                                answer: clipped
                                    ? `${task.proof.answer.slice(0, PROOF_PREVIEW_CHARS)}…`
                                    : task.proof.answer,
                                context: undefined,
                                commitIds: task.proof.commitIds?.slice(0, PROOF_PREVIEW_IDS),
                                attachmentIds: task.proof.attachmentIds?.slice(0, PROOF_PREVIEW_IDS),
                            },
                        };
                    });
                }

                return row;
            });

            const shown =
                offset === 0
                    ? `showing ${page.length}`
                    : page.length === 0
                      ? `showing none (offset ${offset} is past the last row)`
                      : `showing rows ${offset + 1}-${offset + page.length} (offset ${offset} skipped the first ${offset})`;
            const info: string[] = [`${total} handoff${total === 1 ? "" : "s"} matched; ${shown}.`];

            if (agentFilter !== undefined) {
                info.push(
                    isKnownAgent(agentFilter)
                        ? `Filtered to handoffs addressed to harness "${agentFilter}" — the intended recipient, not the poster.`
                        : `agent filter "${agentFilter}" is not a documented harness (${HANDOFF_AGENTS_LIST}) — matched as literal text against target.agent.`
                );
            }

            if (sessionFilter !== undefined) {
                info.push(
                    `Filtered to handoffs addressed to session "${sessionFilter}" — matches target.sessionId (exactly or by leading-segment abbreviation) or target.sessionName.`
                );
            }

            if (proofsClipped) {
                info.push("Task proofs are previews on list — call handoff_get for the full proof.");
            }

            if (total > offset + page.length) {
                info.push(`More available — pass offset: ${offset + page.length}.`);
            }

            if (ignored.length > 0) {
                info.push(`include sections ignored on list (only "tasks" applies): ${ignored.join(", ")}.`);
            }

            return { handoffs, info };
        });
    }
}
