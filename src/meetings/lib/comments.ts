import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { type DecisionActor, type MeetingStore, savedDecisionActorSchema } from "@genesiscz/utils/meetings/record";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { z } from "zod";
import { listenerAlive } from "./answer-log";
import {
    type CommentListener,
    commentListenerSchema,
    commentSchema,
    type MeetingComment,
    type StagedComment,
} from "./comment-schema";
import { appendLines, parseJsonLine } from "./ndjson-lines";

export {
    type CommentListener,
    commentListenerSchema,
    commentSchema,
    type MeetingComment,
    meetingCommentSchema,
    type StagedComment,
} from "./comment-schema";

/**
 * Comments for the agent that listens to a meeting (R43): a person selects words in the transcript, stages a comment
 * on them, and sends the staged comments. `comments.ndjson` in the meeting's folder keeps every step, one line each,
 * oldest first and append-only, so a closed window loses no staged comment and `listen --subscribe-answers
 * --with-comments` follows the sends. A listening process also writes a line when it starts and one when it ends, so a
 * sender can tell who receives (G60).
 */

/** The file in a meeting's folder that keeps its comments and their listeners. */
export const COMMENTS_FILE = "comments.ndjson";

const commentLineSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("staged"), comment: commentSchema }),
    z.object({ kind: z.literal("unstaged"), at: z.string(), id: z.string(), actor: savedDecisionActorSchema }),
    /** The comments it sent, whole, so a follower prints them without reading the lines before. */
    z.object({
        kind: z.literal("sent"),
        at: z.string(),
        token: z.string(),
        actor: savedDecisionActorSchema,
        comments: z.array(commentSchema),
    }),
    z.object({ kind: z.literal("read"), at: z.string(), id: z.string(), actor: savedDecisionActorSchema }),
    z.object({ kind: z.literal("withdrawn"), at: z.string(), id: z.string(), actor: savedDecisionActorSchema }),
    z.object({ kind: z.literal("listening"), listener: commentListenerSchema }),
    z.object({ kind: z.literal("left"), at: z.string(), pid: z.number().int() }),
]);
export type CommentLine = z.infer<typeof commentLineSchema>;

/** Why a comment step was refused: the code lets the window tell a stale list from a wrong id. */
export class CommentError extends Error {
    constructor(
        readonly code: "unknown-comment" | "already-sent" | "already-read" | "withdrawn-comment" | "wrong-actor",
        message: string
    ) {
        super(message);
        this.name = "CommentError";
    }
}

/** A line of the file, or nothing for a line that does not read (a torn last line, logged; a future kind). */
export function parseCommentLine(line: string, path: string): CommentLine | undefined {
    return commentLineOf(parseJsonLine(line, path));
}

/**
 * The number of the next comment id: above every id a staged or sent line still holds, and above the count of staged
 * lines, so a line that stopped reading never hands its id to a new comment that `list()` would merge with an old one.
 */
function nextCommentNumber(lines: CommentLine[]): number {
    let highest = 0;
    let staged = 0;

    for (const line of lines) {
        if (line.kind === "staged") {
            staged++;
            highest = Math.max(highest, commentIdNumber(line.comment.id));
        } else if (line.kind === "sent") {
            for (const comment of line.comments) {
                highest = Math.max(highest, commentIdNumber(comment.id));
            }
        }
    }

    return Math.max(highest, staged) + 1;
}

/** The number in a `c<N>` comment id, or 0 for an id of another shape. */
function commentIdNumber(id: string): number {
    const number = /^c(\d+)$/.exec(id)?.[1];
    return number ? Number(number) : 0;
}

/** A parsed line as a comment line, or nothing for another shape. */
function commentLineOf(value: unknown): CommentLine | undefined {
    const parsed = commentLineSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

export interface MeetingCommentsOptions {
    now?: () => Date;
    /** Whether a listener's pid still runs `meetings listen`; a recycled pid is no listener. */
    alive?: (pid: number) => boolean;
}

/** One meeting's comments file: what is staged, what was sent, and who listens. */
export class MeetingComments {
    private writing = false;

    transaction<T>(change: () => T): T {
        if (this.writing) {
            return change();
        }

        return withPathArbitrationSync(this.path, () => {
            this.writing = true;
            try {
                return change();
            } finally {
                this.writing = false;
            }
        });
    }

    constructor(
        readonly path: string,
        private readonly options: MeetingCommentsOptions = {}
    ) {}

    static of(store: MeetingStore, meeting: string, options: MeetingCommentsOptions = {}): MeetingComments {
        return new MeetingComments(join(store.folder(meeting), COMMENTS_FILE), options);
    }

    /** Every line that reads, oldest first. */
    lines(): CommentLine[] {
        if (!existsSync(this.path)) {
            return [];
        }

        return Array.from(readLinesSync(this.path)).flatMap((line) => parseCommentLine(line, this.path) ?? []);
    }

    /** The staged and sent comments, in the order they were staged (an unstaged one is gone). */
    list(): MeetingComment[] {
        const comments = new Map<string, MeetingComment>();

        for (const line of this.lines()) {
            if (line.kind === "staged") {
                comments.set(line.comment.id, { ...line.comment, state: "staged" });
            } else if (line.kind === "unstaged") {
                comments.delete(line.id);
            } else if (line.kind === "sent") {
                for (const sent of line.comments) {
                    comments.set(sent.id, { ...sent, state: "sent", sentAt: line.at, token: line.token });
                }
            } else if (line.kind === "read" || line.kind === "withdrawn") {
                const comment = comments.get(line.id);
                if (comment) {
                    comments.set(
                        line.id,
                        line.kind === "read"
                            ? { ...comment, readAt: line.at, readBy: line.actor }
                            : { ...comment, withdrawnAt: line.at }
                    );
                }
            }
        }

        return [...comments.values()];
    }

    /** The listening processes that still run, oldest first. */
    listeners(): CommentListener[] {
        const listening = new Map<number, CommentListener>();

        for (const line of this.lines()) {
            if (line.kind === "listening") {
                listening.set(line.listener.pid, line.listener);
            } else if (line.kind === "left") {
                listening.delete(line.pid);
            }
        }

        const alive = this.options.alive ?? listenerAlive;
        return [...listening.values()].filter((listener) => alive(listener.pid));
    }

    stage(input: {
        target: StagedComment["target"];
        text: string;
        quote?: string;
        actor: DecisionActor;
    }): MeetingComment {
        return this.transaction(() => {
            const comment: StagedComment = {
                id: `c${nextCommentNumber(this.lines())}`,
                at: this.now(),
                target: input.target,
                text: input.text,
                ...(input.quote ? { quote: input.quote } : {}),
                actor: input.actor,
            };
            this.append({ kind: "staged", comment });
            return { ...comment, state: "staged" };
        });
    }

    /** Takes a staged comment back; a sent one stays sent (the listening agent has it). */
    unstage(id: string, actor: DecisionActor): MeetingComment {
        return this.transaction(() => {
            const comment = this.staged([id])[0]!;
            this.requireCommentAuthor(comment, actor);
            this.append({ kind: "unstaged", at: this.now(), id, actor });
            return comment;
        });
    }

    /** The staged comments a send takes: `ids`, or every staged one. Refused for an unknown or a sent id. */
    staged(ids?: string[]): MeetingComment[] {
        const comments = this.list();

        if (!ids) {
            return comments.filter((comment) => comment.state === "staged");
        }

        return ids.map((id) => {
            const comment = comments.find((one) => one.id === id);

            if (!comment) {
                throw new CommentError("unknown-comment", `No staged comment ${id}.`);
            }

            if (comment.state === "sent") {
                throw new CommentError(
                    "already-sent",
                    `Comment ${id} was sent at ${comment.sentAt}; it cannot change.`
                );
            }

            return comment;
        });
    }

    /** Marks the comments sent under the journal entry `token`; each listener prints them from this line. */
    markSent(comments: MeetingComment[], sent: { token: string; at: string; actor: DecisionActor }): MeetingComment[] {
        this.append({
            kind: "sent",
            at: sent.at,
            token: sent.token,
            actor: sent.actor,
            comments: comments.map(({ state: _state, sentAt: _sentAt, token: _token, ...comment }) => comment),
        });
        return comments.map((comment) => ({ ...comment, state: "sent", sentAt: sent.at, token: sent.token }));
    }

    /** A receiver acknowledges a sent comment before acting on it. Delivery alone is not a read receipt. */
    acknowledge(id: string, actor: DecisionActor): MeetingComment {
        return this.transaction(() => {
            const comment = this.list().find((entry) => entry.id === id);
            if (comment?.state !== "sent") {
                throw new CommentError("unknown-comment", `No sent comment ${id}.`);
            }
            if (comment.withdrawnAt) {
                throw new CommentError("withdrawn-comment", `Comment ${id} was withdrawn before it was read.`);
            }
            if (sameCommentAuthor(comment.actor, actor)) {
                throw new CommentError("wrong-actor", "A comment's author cannot acknowledge its own comment.");
            }

            if (comment.readAt) {
                return comment;
            }

            const at = this.now();
            this.append({ kind: "read", id, at, actor });
            return { ...comment, readAt: at, readBy: actor };
        });
    }

    /** A sent comment can be withdrawn until a receiver acknowledges it. Followers receive a retraction event. */
    withdraw(id: string, actor: DecisionActor): MeetingComment {
        return this.transaction(() => {
            const comment = this.list().find((entry) => entry.id === id);
            if (!comment) {
                throw new CommentError("unknown-comment", `No comment ${id}.`);
            }
            this.requireCommentAuthor(comment, actor);
            if (comment.readAt) {
                throw new CommentError(
                    "already-read",
                    `Comment ${id} was read at ${comment.readAt}; it cannot be withdrawn.`
                );
            }
            if (comment.withdrawnAt) {
                return comment;
            }
            if (comment.state === "staged") {
                return this.unstage(id, actor);
            }

            const at = this.now();
            this.append({ kind: "withdrawn", id, at, actor });
            return { ...comment, withdrawnAt: at };
        });
    }

    /** A listening process starts: senders count it until it leaves or its pid ends. */
    join(listener: { pid: number; actor: DecisionActor }): void {
        this.append({ kind: "listening", listener: { pid: listener.pid, at: this.now(), actor: listener.actor } });
    }

    leave(pid: number): void {
        this.append({ kind: "left", at: this.now(), pid });
    }

    /**
     * Prints each comment sent from now on as one JSON line (`fromStart`: every comment sent before too), until
     * `stop`, which reads what was appended last first.
     */
    follow(options: { fromStart: boolean; write: (line: string) => void }): { stop(): void } {
        const print = (line: CommentLine | undefined): void => {
            for (const entry of line ? commentStreamLines(line) : []) {
                options.write(SafeJSON.stringify(entry, { jsonl: true }));
            }
        };
        const snapshot = existsSync(this.path) ? readFileSync(this.path) : Buffer.alloc(0);
        const replayEnd = snapshot.lastIndexOf(10) + 1;

        if (options.fromStart) {
            for (const line of snapshot.subarray(0, replayEnd).toString("utf8").split("\n")) {
                print(parseCommentLine(line, this.path));
            }
        }

        const tailer = new FileTailer<unknown>(
            this.path,
            { onLine: (value) => print(commentLineOf(value)) },
            { create: false, from: replayEnd }
        );
        tailer.start();
        return {
            stop: () => {
                tailer.flush();
                tailer.stop();
            },
        };
    }

    private requireCommentAuthor(comment: MeetingComment, actor: DecisionActor): void {
        if (actor.kind === "window" || actor.kind === "cli" || sameCommentAuthor(comment.actor, actor)) {
            return;
        }

        throw new CommentError("wrong-actor", "Only the author or the person can retract a comment.");
    }

    private now(): string {
        return (this.options.now?.() ?? new Date()).toISOString();
    }

    /** One line at the end; after a torn last line (a writer that died mid-line) on a line of its own. */
    private append(line: CommentLine): void {
        this.transaction(() => appendLines(this.path, [SafeJSON.stringify(line, { jsonl: true })], { mode: 0o600 }));
    }
}

function sameCommentAuthor(left: DecisionActor, right: DecisionActor): boolean {
    if (left.kind !== right.kind) {
        return [left.kind, right.kind].every((kind) => kind === "window" || kind === "cli");
    }

    if (left.kind === "agent" && right.kind === "agent") {
        return left.harness === right.harness && left.session === right.session;
    }

    if (left.kind === "rule" && right.kind === "rule") {
        return left.rule === right.rule;
    }

    return true;
}

/** The lines `--with-comments` prints for one send: one per comment, each with `type: "comment"`. */
export function commentStreamLines(line: CommentLine): Array<Record<string, unknown>> {
    if (line.kind === "withdrawn") {
        return [{ type: "comment-withdrawn", event: "comment.withdrawn", id: line.id, at: line.at }];
    }

    if (line.kind !== "sent") {
        return [];
    }

    return line.comments.map((comment) => ({
        type: "comment",
        event: "comment",
        at: line.at,
        id: comment.id,
        text: comment.text,
        ...(comment.quote ? { quote: comment.quote } : {}),
        target: comment.target,
        token: line.token,
    }));
}
