import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { storage } from "@app/gitlab/lib/config";
import { HttpError } from "@app/gitlab/lib/http";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface LedgerEntry {
    /** Project path or id the note went to. */
    project: string;
    pr: string;
    comment_id: number;
    message: string;
    ts: string;
}

export interface PostResult {
    iid: string;
    ok: boolean;
    status: number;
    commentId?: number;
    error?: string;
    skipped?: boolean;
}

const mrPath = (api: ProjectApi, iid: string): string => `${projectBase(api)}/merge_requests/${iid}`;

const asResult = (iid: string, e: unknown): PostResult =>
    e instanceof HttpError
        ? { iid, ok: false, status: e.status, error: (e.body ?? "").slice(0, 200) }
        : { iid, ok: false, status: 0, error: String(e).slice(0, 200) };

export function ledgerPath(): string {
    const dir = storage.getBaseDir();
    mkdirSync(dir, { recursive: true });

    return join(dir, "comment-batch.jsonl");
}

export function readLedger(): LedgerEntry[] {
    const path = ledgerPath();
    if (!existsSync(path)) {
        return [];
    }

    const seen = new Set<string>();
    const entries: LedgerEntry[] = [];

    for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
        let entry: LedgerEntry;

        try {
            entry = SafeJSON.parse(line, { strict: true }) as LedgerEntry;
        } catch (error) {
            logger.debug({ error, path }, "gitlab: skipping unparsable comment ledger line");
            continue;
        }

        const key = `${entry.project}:${entry.pr}:${entry.message}:${entry.comment_id}`;
        if (!seen.has(key)) {
            seen.add(key);
            entries.push(entry);
        }
    }

    return entries;
}

/** Ledger entries of one MR of one project. */
export function ledgerFor(ledger: LedgerEntry[], project: string, iid: string | number): LedgerEntry[] {
    return ledger.filter((e) => e.project === project && e.pr === String(iid));
}

export function isDuplicate(ledger: LedgerEntry[], ref: { project: string; iid: string; message: string }): boolean {
    return ledgerFor(ledger, ref.project, ref.iid).some((e) => e.message === ref.message);
}

export function appendLedger(entry: LedgerEntry): void {
    appendFileSync(ledgerPath(), `${SafeJSON.stringify(entry)}\n`);
}

export async function postComment(api: ProjectApi, iid: string, body: string): Promise<PostResult> {
    try {
        const note = await restWrite<{ id: number }>(api, {
            method: "POST",
            path: `${mrPath(api, iid)}/notes`,
            body: { body },
        });

        return { iid, ok: true, status: 201, commentId: note.id };
    } catch (e) {
        return asResult(iid, e);
    }
}

/** A GitLab draft note: visible only to its author until published, so nothing reaches the team yet. */
export async function postDraftNote(api: ProjectApi, iid: string, body: string): Promise<PostResult> {
    try {
        const draft = await restWrite<{ id: number }>(api, {
            method: "POST",
            path: `${mrPath(api, iid)}/draft_notes`,
            body: { note: body },
        });

        return { iid, ok: true, status: 201, commentId: draft.id };
    } catch (e) {
        return asResult(iid, e);
    }
}

export async function getNote(
    api: ProjectApi,
    iid: string,
    noteId: number
): Promise<{ id: number; body: string; author: string } | null> {
    try {
        const raw = await restGet<{ id: number; body: string; author: { username: string } }>(
            api,
            `${mrPath(api, iid)}/notes/${noteId}`
        );

        return { id: raw.id, body: raw.body, author: raw.author.username };
    } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
            return null;
        }

        throw e;
    }
}

/** Edit an existing note in place; used to append a side comment instead of posting a second note. */
export async function updateNote(
    api: ProjectApi,
    note: { iid: string; noteId: number; body: string }
): Promise<PostResult> {
    try {
        await restWrite<void>(api, {
            method: "PUT",
            path: `${mrPath(api, note.iid)}/notes/${note.noteId}`,
            body: { body: note.body },
        });

        return { iid: note.iid, ok: true, status: 200, commentId: note.noteId };
    } catch (e) {
        return asResult(note.iid, e);
    }
}

/** Every page, as `fetchDrafts` reads the same endpoint: a lookup by id missed a draft past page one. */
export async function fetchDraftNotes(api: ProjectApi, iid: string): Promise<Array<{ id: number; note: string }>> {
    return restGetPaginated<{ id: number; note: string }>(api, `${mrPath(api, iid)}/draft_notes`);
}

/** Replace the text of an unpublished draft note, used to fold a side comment into the pending review draft. */
export async function updateDraftNote(
    api: ProjectApi,
    draft: { iid: string; draftId: number; body: string }
): Promise<PostResult> {
    try {
        await restWrite<void>(api, {
            method: "PUT",
            path: `${mrPath(api, draft.iid)}/draft_notes/${draft.draftId}`,
            body: { note: draft.body },
        });

        return { iid: draft.iid, ok: true, status: 200, commentId: draft.draftId };
    } catch (e) {
        return asResult(draft.iid, e);
    }
}

export async function publishDraftNote(
    api: ProjectApi,
    iid: string,
    draftId: number
): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
        // Once only: a publish that landed and is retried answers 404, reporting a success as a failure.
        await restWrite<void>(api, {
            method: "PUT",
            path: `${mrPath(api, iid)}/draft_notes/${draftId}/publish`,
            retries: 1,
        });

        return { ok: true, status: 200 };
    } catch (e) {
        const result = asResult(iid, e);

        return { ok: false, status: result.status, error: result.error };
    }
}
