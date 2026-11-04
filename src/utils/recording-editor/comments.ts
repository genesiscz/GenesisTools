import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const { log } = logger.scoped("recording-editor-comments");

/**
 * Review comments of a recording, beside it as `comments.jsonl` (`<name>.comments.jsonl` beside a plain movie), the
 * file the editor window reads and writes too (Project/ReviewComments.swift). Each line is one change: a new comment,
 * a later version of one (same id, the last line wins), or its removal (`deleted: true`). Appending never loses a
 * line another writer added at the same time. Times are SOURCE microseconds, as in edit.json, so a cut never moves a
 * comment.
 */
export const COMMENTS_FILE = "comments.jsonl";

export const commentLineSchema = z.object({
    id: z.string().min(1),
    atUs: z.number().int().nonnegative(),
    /** The end of a commented range; absent is a point. */
    toUs: z.number().int().positive().optional(),
    text: z.string().max(2000).default(""),
    author: z.string().max(80).optional(),
    /** Where it came from: a vitrinka board, a PR, a chat (the page a comment answers). */
    link: z.string().url().optional(),
    resolved: z.boolean().optional(),
    deleted: z.boolean().optional(),
    /** ISO time of this line. */
    at: z.string(),
});
export type CommentLine = z.infer<typeof commentLineSchema>;
export type ReviewComment = Omit<CommentLine, "deleted">;

/** Where the comments of a movie live: a recording folder's `comments.jsonl`, else `<name>.comments.jsonl`. */
export function commentsPathFor(video: string): string {
    const folder = dirname(video);

    if (existsSync(join(folder, "recording.json"))) {
        return join(folder, COMMENTS_FILE);
    }

    return join(folder, `${basename(video, extname(video))}.comments.jsonl`);
}

function parseLine(raw: string): unknown {
    try {
        return SafeJSON.parse(raw, { strict: true });
    } catch (error) {
        log.debug({ error }, "a comment line is not JSON");
        return null;
    }
}

/** The comments as they stand, in time order: each id's last line, without the removed ones. */
export function readComments(path: string): ReviewComment[] {
    if (!existsSync(path)) {
        return [];
    }

    const latest = new Map<string, CommentLine>();

    for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
        if (!raw.trim()) {
            continue;
        }

        const parsed = commentLineSchema.safeParse(parseLine(raw));

        if (!parsed.success) {
            log.warn({ path, line: index + 1 }, "skipped a comment line that does not parse");
            continue;
        }

        latest.set(parsed.data.id, parsed.data);
    }

    return [...latest.values()]
        .filter((line) => !line.deleted)
        .map(({ deleted: _deleted, ...comment }) => comment)
        .sort((a, b) => a.atUs - b.atUs || a.at.localeCompare(b.at));
}

function append(path: string, line: CommentLine): void {
    appendFileSync(path, `${SafeJSON.stringify(commentLineSchema.parse(line), { jsonl: true })}\n`);
}

export function addComment(
    path: string,
    comment: { atUs: number; toUs?: number; text: string; author?: string; link?: string }
): ReviewComment {
    if (comment.toUs !== undefined && comment.toUs <= comment.atUs) {
        throw new RangeError(
            `a comment's range ends (${comment.toUs / 1e6} s) before it starts (${comment.atUs / 1e6} s)`
        );
    }

    const line: CommentLine = {
        id: `m${randomUUID().slice(0, 8)}`,
        atUs: Math.round(comment.atUs),
        ...(comment.toUs === undefined ? {} : { toUs: Math.round(comment.toUs) }),
        text: comment.text.trim(),
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.link ? { link: comment.link } : {}),
        at: new Date().toISOString(),
    };
    append(path, line);
    return line;
}

function existing(path: string, id: string): ReviewComment {
    const found = readComments(path).find((comment) => comment.id === id);

    if (!found) {
        const ids = readComments(path).map((comment) => comment.id);
        throw new Error(`no comment ${id}; comments: ${ids.join(", ") || "none"}`);
    }

    return found;
}

/** A new version of a comment: its text, its time, or whether it is resolved. */
export function updateComment(
    path: string,
    id: string,
    change: { text?: string; atUs?: number; toUs?: number; resolved?: boolean }
): ReviewComment {
    const line: CommentLine = {
        ...existing(path, id),
        ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
        at: new Date().toISOString(),
    };
    append(path, line);
    return line;
}

export function removeComment(path: string, id: string): void {
    append(path, { ...existing(path, id), deleted: true, at: new Date().toISOString() });
}
