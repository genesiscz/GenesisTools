import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { HttpError } from "@app/gitlab/lib/http";

export interface DiscussionSummary {
    id: string;
    author: string;
    path: string | null;
    line: number | null;
    body: string;
    resolved: boolean;
    noteCount: number;
}

export interface DraftSummary {
    id: number;
    discussionId: string | null;
    path: string | null;
    line: number | null;
    note: string;
}

export interface DraftWriteResult {
    ok: boolean;
    action: "created" | "updated" | "failed";
    draftId?: number;
    discussionId?: string | null;
    error?: string;
}

interface RawPosition {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
}

interface RawNote {
    id: number;
    body?: string;
    system?: boolean;
    resolved?: boolean;
    author?: { username?: string };
    position?: RawPosition;
}

interface RawDraft {
    id: number;
    note?: string;
    discussion_id?: string | null;
    position?: RawPosition;
}

const mrPath = (api: ProjectApi, iid: string): string => `${projectBase(api)}/merge_requests/${iid}`;

const failure = (e: unknown): DraftWriteResult => ({
    ok: false,
    action: "failed",
    error: e instanceof HttpError ? `${e.status} ${(e.body ?? "").slice(0, 300)}` : String(e),
});

const anchorOf = (position: RawPosition | undefined): { path: string | null; line: number | null } => ({
    path: position?.new_path ?? position?.old_path ?? null,
    line: position?.new_line ?? position?.old_line ?? null,
});

/**
 * Threads on an MR, each reduced to its opening note. `author` is who started the thread, which is
 * who second person addresses in a reply.
 */
export async function fetchDiscussions(api: ProjectApi, iid: string): Promise<DiscussionSummary[]> {
    const raw = await restGetPaginated<{ id: string; notes?: RawNote[] }>(api, `${mrPath(api, iid)}/discussions`);
    const summaries: DiscussionSummary[] = [];

    for (const discussion of raw) {
        const human = (discussion.notes ?? []).filter((note) => !note.system);
        const first = human[0];

        if (!first) {
            continue;
        }

        const { path, line } = anchorOf(first.position);

        summaries.push({
            id: discussion.id,
            author: first.author?.username ?? "unknown",
            path,
            line,
            body: (first.body ?? "").replace(/\s+/g, " ").trim(),
            resolved: Boolean(first.resolved),
            noteCount: human.length,
        });
    }

    return summaries;
}

/** Pending (unpublished) drafts, carrying the anchor so a caller can prove where each one landed. */
export async function fetchDrafts(api: ProjectApi, iid: string): Promise<DraftSummary[]> {
    const raw = await restGetPaginated<RawDraft>(api, `${mrPath(api, iid)}/draft_notes`);

    return raw.map((draft) => {
        const { path, line } = anchorOf(draft.position);

        return { id: draft.id, discussionId: draft.discussion_id ?? null, path, line, note: draft.note ?? "" };
    });
}

/**
 * GitLab allows one pending draft per discussion per author, so a second POST is rejected with
 * `author_id has already been taken`. Callers almost always mean "make my reply to this thread say
 * this", so an existing draft is updated instead of failing.
 *
 * Pass `knownDrafts` when writing several replies in a row; otherwise each call re-fetches the same
 * list.
 */
export async function writeDraftReply(
    api: ProjectApi,
    reply: { iid: string; discussionId: string; body: string; append?: boolean; knownDrafts?: DraftSummary[] }
): Promise<DraftWriteResult> {
    const { iid, discussionId, body } = reply;
    const drafts = reply.knownDrafts ?? (await fetchDrafts(api, iid));
    const existing = drafts.find((draft) => draft.discussionId === discussionId);

    try {
        if (existing) {
            const note = reply.append ? `${existing.note}\n\n---\n\n${body}` : body;
            await restWrite<RawDraft>(api, {
                method: "PUT",
                path: `${mrPath(api, iid)}/draft_notes/${existing.id}`,
                body: { note },
            });

            return { ok: true, action: "updated", draftId: existing.id, discussionId };
        }

        const created = await restWrite<RawDraft>(api, {
            method: "POST",
            path: `${mrPath(api, iid)}/draft_notes`,
            body: { note: body, in_reply_to_discussion_id: discussionId },
        });

        return { ok: true, action: "created", draftId: created.id, discussionId: created.discussion_id ?? null };
    } catch (e) {
        return failure(e);
    }
}

export interface DiffRefs {
    base_sha: string;
    start_sha: string;
    head_sha: string;
}

export async function fetchDiffRefs(api: ProjectApi, iid: string): Promise<DiffRefs> {
    const mr = await restGet<{ diff_refs?: DiffRefs }>(api, mrPath(api, iid));

    if (!mr.diff_refs) {
        throw new Error(`!${iid} has no diff_refs; it may be closed or have no diff.`);
    }

    return mr.diff_refs;
}

/**
 * A draft anchored to a line of the diff.
 *
 * The position must go in a JSON body. GitLab accepts `position[...]` form pairs on `/discussions`
 * but silently drops them on `/draft_notes`, answering 201 with every position field null, so the
 * comment lands as a top-level note. `restWrite` always sends JSON, and the anchor is read back
 * here rather than trusted.
 */
export async function writeAnchoredDraft(
    api: ProjectApi,
    draft: { iid: string; path: string; line: number; body: string }
): Promise<DraftWriteResult> {
    try {
        const refs = await fetchDiffRefs(api, draft.iid);
        const created = await restWrite<RawDraft>(api, {
            method: "POST",
            path: `${mrPath(api, draft.iid)}/draft_notes`,
            body: {
                note: draft.body,
                position: {
                    ...refs,
                    position_type: "text",
                    old_path: draft.path,
                    new_path: draft.path,
                    new_line: draft.line,
                },
            },
        });

        if (!created.position?.new_line) {
            return {
                ok: false,
                action: "failed",
                draftId: created.id,
                error: `draft ${created.id} was created without an anchor and is now a top-level note. Delete it and retry.`,
            };
        }

        return { ok: true, action: "created", draftId: created.id, discussionId: null };
    } catch (e) {
        return failure(e);
    }
}

/** A standalone draft with no thread. There is no one-per-discussion limit here. */
export async function writeTopLevelDraft(api: ProjectApi, iid: string, body: string): Promise<DraftWriteResult> {
    try {
        const created = await restWrite<RawDraft>(api, {
            method: "POST",
            path: `${mrPath(api, iid)}/draft_notes`,
            body: { note: body },
        });

        return { ok: true, action: "created", draftId: created.id, discussionId: null };
    } catch (e) {
        return failure(e);
    }
}

export async function deleteDraft(
    api: ProjectApi,
    iid: string,
    draftId: number
): Promise<{ ok: boolean; error?: string }> {
    try {
        await restWrite<void>(api, { method: "DELETE", path: `${mrPath(api, iid)}/draft_notes/${draftId}` });

        return { ok: true };
    } catch (e) {
        return { ok: false, error: failure(e).error };
    }
}

export async function publishAllDrafts(api: ProjectApi, iid: string): Promise<{ ok: boolean; error?: string }> {
    try {
        await restWrite<void>(api, { method: "POST", path: `${mrPath(api, iid)}/draft_notes/bulk_publish` });

        return { ok: true };
    } catch (e) {
        return { ok: false, error: failure(e).error };
    }
}

/**
 * A malformed anchor is accepted with 201 and silently becomes a top-level note, so a draft that
 * should be a reply but carries no discussion id is reported here rather than discovered in the UI.
 */
export function findUnanchoredDrafts(drafts: DraftSummary[], intentionalTopLevel: number[] = []): DraftSummary[] {
    return drafts.filter((draft) => draft.discussionId === null && !intentionalTopLevel.includes(draft.id));
}

export function renderDiscussionTable(discussions: DiscussionSummary[]): string {
    const rows = discussions.map((discussion) => {
        const anchor = discussion.path ? `${discussion.path}:${discussion.line ?? "-"}` : "TOP-LEVEL";
        const state = discussion.resolved ? "resolved" : "open";
        const body = discussion.body.replace(/\s+/g, " ").trim().slice(0, 100);

        return `${discussion.id.slice(0, 12)}  ${discussion.author.padEnd(16)} ${state.padEnd(8)} ${String(discussion.noteCount).padStart(2)}  ${anchor}\n    ${body}`;
    });

    return rows.join("\n");
}

export function renderDraftTable(drafts: DraftSummary[]): string {
    return drafts
        .map((draft) => {
            const target = draft.discussionId ? `reply → ${draft.discussionId.slice(0, 12)}` : "TOP-LEVEL";
            const anchor = draft.path ? `${draft.path}:${draft.line ?? "-"}` : "";

            return `${String(draft.id).padStart(6)}  ${target.padEnd(24)} ${String(draft.note.length).padStart(5)} chars  ${anchor}`;
        })
        .join("\n");
}

// ─── thread and note operations the CLI does not expose ────────────────────────

export async function resolveDiscussion(
    api: ProjectApi,
    thread: { iid: string; discussionId: string; resolved?: boolean }
): Promise<{ ok: boolean; error?: string }> {
    try {
        await restWrite<void>(api, {
            method: "PUT",
            path: `${mrPath(api, thread.iid)}/discussions/${thread.discussionId}`,
            body: { resolved: thread.resolved ?? true },
        });

        return { ok: true };
    } catch (e) {
        return { ok: false, error: failure(e).error };
    }
}

/** Publishes straight away, unlike a draft. Use it when the reply should not wait for a review batch. */
export async function postReplyNow(
    api: ProjectApi,
    reply: { iid: string; discussionId: string; body: string }
): Promise<{ ok: boolean; noteId?: number; error?: string }> {
    try {
        const note = await restWrite<{ id: number }>(api, {
            method: "POST",
            path: `${mrPath(api, reply.iid)}/discussions/${reply.discussionId}/notes`,
            body: { body: reply.body },
        });

        return { ok: true, noteId: note.id };
    } catch (e) {
        return { ok: false, error: failure(e).error };
    }
}

export async function postNote(
    api: ProjectApi,
    iid: string,
    body: string
): Promise<{ ok: boolean; noteId?: number; error?: string }> {
    try {
        const note = await restWrite<{ id: number }>(api, {
            method: "POST",
            path: `${mrPath(api, iid)}/notes`,
            body: { body },
        });

        return { ok: true, noteId: note.id };
    } catch (e) {
        return { ok: false, error: failure(e).error };
    }
}
