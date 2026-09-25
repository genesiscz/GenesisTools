import { createHash } from "node:crypto";
import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { HttpError } from "@app/gitlab/lib/http";
import type { DiffFile } from "@app/gitlab/lib/pr-review";

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
    line_range?: { start?: { line_code?: string | null }; end?: { line_code?: string | null } } | null;
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

/** One end of a GitLab `line_range`: `line_code` is `<sha1 of the path>_<old counter>_<new counter>`. */
export interface LineRangeEnd {
    line_code: string;
    type: "new" | "old";
    old_line: number | null;
    new_line: number | null;
}

/** The line part of a GitLab text position; the diff refs are added when the draft is written. */
export interface LinePosition {
    old_path: string;
    new_path: string;
    old_line: number | null;
    new_line: number | null;
    line_range?: { start: LineRangeEnd; end: LineRangeEnd };
}

interface LocatedLine {
    kind: "+" | "-" | " ";
    oldLine: number | null;
    newLine: number | null;
    code: string;
}

/**
 * Every diff line of a file with GitLab's line code. GitLab counts both sides on every line, so an
 * added line's code carries the old-side counter it sits at, and a removed line's the new-side one.
 */
function locateLines(file: DiffFile): LocatedLine[] {
    const pathSha = createHash("sha1").update(file.path).digest("hex");
    const located: LocatedLine[] = [];

    for (const hunk of file.hunks) {
        let oldCounter = hunk.oldStart;
        let newCounter = hunk.newStart;

        for (const line of hunk.lines) {
            located.push({
                kind: line.kind,
                oldLine: line.kind === "+" ? null : oldCounter,
                newLine: line.kind === "-" ? null : newCounter,
                code: `${pathSha}_${oldCounter}_${newCounter}`,
            });

            if (line.kind !== "+") {
                oldCounter++;
            }

            if (line.kind !== "-") {
                newCounter++;
            }
        }
    }

    return located;
}

/**
 * Where a line of the MR diff is, as the position GitLab wants for a draft: `additions` counts on
 * the new side, `deletions` on the old. A context line carries both numbers, which GitLab requires
 * (a context line with only `new_line` is silently created unanchored). `startLine` makes a
 * multi-line range. A line outside the diff's hunks is an error string, never a guessed anchor.
 */
export function diffLinePosition(options: {
    file: DiffFile;
    side: "additions" | "deletions";
    line: number;
    startLine?: number;
}): LinePosition | string {
    const { file, side, line, startLine } = options;
    const lines = locateLines(file);
    const find = (wanted: number): LocatedLine | undefined =>
        lines.find((candidate) =>
            side === "additions"
                ? candidate.kind !== "-" && candidate.newLine === wanted
                : candidate.kind !== "+" && candidate.oldLine === wanted
        );
    const end = find(line);

    if (!end) {
        return `${file.path}: line ${line} on the ${side === "additions" ? "new" : "old"} side is not in the MR diff`;
    }

    const position: LinePosition = {
        old_path: file.oldPath,
        new_path: file.path,
        old_line: end.oldLine,
        new_line: end.newLine,
    };

    if (startLine === undefined || startLine === line) {
        return position;
    }

    const start = startLine < line ? find(startLine) : undefined;

    if (!start) {
        return `${file.path}: start line ${startLine} is not in the MR diff before line ${line}`;
    }

    const rangeEnd = (located: LocatedLine): LineRangeEnd => ({
        line_code: located.code,
        type: located.kind === "+" ? "new" : "old",
        old_line: located.oldLine,
        new_line: located.newLine,
    });

    return { ...position, line_range: { start: rangeEnd(start), end: rangeEnd(end) } };
}

/**
 * How the anchor GitLab stored differs from the one asked for, or null when it kept it whole. A
 * dropped anchor, another path or line, and a range narrowed to one line all count: GitLab degrades
 * positions silently, answering 201 either way.
 */
export function anchorDrift(requested: LinePosition, stored: RawPosition | null | undefined): string | null {
    if (!stored || (!stored.new_line && !stored.old_line)) {
        return "dropped the anchor";
    }

    const moved = (["new_path", "old_path", "new_line", "old_line"] as const).filter(
        (key) => (stored[key] ?? null) !== requested[key]
    );

    if (moved.length > 0) {
        return `moved the anchor (${moved.map((key) => `${key} ${requested[key]} became ${stored[key] ?? null}`).join(", ")})`;
    }

    const range = requested.line_range;

    if (
        range &&
        (stored.line_range?.start?.line_code !== range.start.line_code ||
            stored.line_range?.end?.line_code !== range.end.line_code)
    ) {
        return "dropped the line range";
    }

    return null;
}

/**
 * A draft at a precomputed position (see `diffLinePosition`), read back to prove GitLab kept the
 * anchor as asked. A draft GitLab stored without it, or elsewhere, is deleted again rather than
 * left as a top-level or misplaced note.
 */
export async function writePositionedDraft(
    api: ProjectApi,
    draft: { iid: string; body: string; position: LinePosition }
): Promise<DraftWriteResult> {
    const { position } = draft;
    const where = `${position.new_path}:${position.new_line ?? position.old_line}`;

    try {
        const refs = await fetchDiffRefs(api, draft.iid);
        const created = await restWrite<RawDraft>(api, {
            method: "POST",
            path: `${mrPath(api, draft.iid)}/draft_notes`,
            body: { note: draft.body, position: { ...refs, position_type: "text", ...position } },
        });
        const drift = anchorDrift(position, created.position);

        if (drift) {
            // The POST already created the draft. Take it back rather than leave a stray or
            // misplaced note on the MR for the author to find and delete by hand.
            const removed = await deleteDraft(api, draft.iid, created.id);

            return {
                ok: false,
                action: "failed",
                draftId: removed.ok ? undefined : created.id,
                error: removed.ok
                    ? `GitLab ${drift} for ${where}; the draft it created was deleted again.`
                    : `draft ${created.id} was stored off its anchor (GitLab ${drift}), and deleting it failed (${removed.error}). Delete it by hand.`,
            };
        }

        return { ok: true, action: "created", draftId: created.id, discussionId: null };
    } catch (e) {
        return failure(e);
    }
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
    // A NaN line serializes as `null`, GitLab accepts that, and the draft is created unanchored.
    // Refused before any request, so no stray top-level note is left behind.
    if (!Number.isInteger(draft.line) || draft.line < 1) {
        return { ok: false, action: "failed", error: `line must be a positive line number, got ${draft.line}` };
    }

    return writePositionedDraft(api, {
        iid: draft.iid,
        body: draft.body,
        position: { old_path: draft.path, new_path: draft.path, old_line: null, new_line: draft.line },
    });
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
        // Once only, like `publishDraftNote`: a delete that landed and is retried answers 404,
        // reporting a draft that is gone as a failed delete.
        await restWrite<void>(api, {
            method: "DELETE",
            path: `${mrPath(api, iid)}/draft_notes/${draftId}`,
            retries: 1,
        });

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
