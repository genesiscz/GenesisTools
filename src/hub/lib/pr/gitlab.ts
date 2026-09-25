import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { publishDraftNote, updateDraftNote } from "@app/gitlab/lib/comment-batch";
import { errorMessage } from "@app/gitlab/lib/http";
import { fetchMrDiffs } from "@app/gitlab/lib/pr-review";
import {
    deleteDraft,
    diffLinePosition,
    fetchDrafts,
    postReplyNow,
    publishAllDrafts,
    resolveDiscussion,
    writeDraftReply,
    writePositionedDraft,
    writeTopLevelDraft,
} from "@app/gitlab/lib/review-drafts";
import { logger } from "@genesiscz/utils/logger";
import {
    type DraftAddInput,
    type FoundPr,
    HubPrError,
    type PrBackend,
    type PrThread,
    type PublishEvent,
    type ThreadComment,
} from "./types";

/**
 * The GitLab half of `tools hub pr`: discussions with positions, my draft notes, and `publish`, which
 * bulk-publishes them. Everything goes through the HTTP client in `src/gitlab/lib/client.ts`.
 */

const log = logger.child({ component: "hub/pr/gitlab" });

/** Draft notes that start a thread get this id prefix, so `resolve` can refuse them before any request. */
const DRAFT_THREAD_PREFIX = "draft-";

interface RawRangeEnd {
    old_line?: number | null;
    new_line?: number | null;
}

interface RawPosition {
    head_sha?: string | null;
    old_path?: string | null;
    new_path?: string | null;
    position_type?: string | null;
    old_line?: number | null;
    new_line?: number | null;
    line_range?: { start?: RawRangeEnd | null; end?: RawRangeEnd | null } | null;
}

interface RawUser {
    username?: string;
    name?: string;
    avatar_url?: string | null;
}

interface RawNote {
    id: number;
    body?: string;
    system?: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    created_at?: string;
    author?: RawUser;
    position?: RawPosition | null;
}

interface RawDiscussion {
    id: string;
    notes?: RawNote[];
}

interface RawDraft {
    id: number;
    note?: string;
    discussion_id?: string | null;
    position?: RawPosition | null;
}

interface GitLabPosition {
    path: string;
    oldPath?: string;
    side: PrThread["side"];
    line: number;
    startLine?: number;
}

/**
 * A GitLab text position as the window's: a line with a new-side number (added or context) is on
 * `additions`, a removed line (old number only) on `deletions`. `line_range` gives the first line of
 * a multi-line comment, counted on the same side. Image and file positions have no line: null.
 */
export function gitlabPosition(position: RawPosition | null | undefined): GitLabPosition | null {
    if (!position || (position.position_type && position.position_type !== "text")) {
        return null;
    }

    const side = position.new_line ? "additions" : "deletions";
    const line = position.new_line ?? position.old_line;
    const path = position.new_path ?? position.old_path;

    if (!line || !path) {
        return null;
    }

    const start = position.line_range?.start;
    const startLine = start ? (side === "additions" ? start.new_line : start.old_line) : null;
    const oldPath = position.old_path && position.old_path !== path ? position.old_path : undefined;
    return {
        path,
        oldPath,
        side,
        line,
        startLine: startLine && startLine !== line ? startLine : undefined,
    };
}

function author(user: RawUser | undefined, mrAuthor: string | null): ThreadComment["author"] {
    const username = user?.username ?? "unknown";
    return {
        name: user?.name || username,
        username,
        avatarUrl: user?.avatar_url ?? undefined,
        role: mrAuthor && username === mrAuthor ? "author" : undefined,
    };
}

/** The discussions that sit on a diff line, with my drafts merged in as `isDraft` comments or threads. */
export function gitlabThreads({
    discussions,
    drafts,
    me,
    pr,
    draftedAt,
}: {
    discussions: RawDiscussion[];
    drafts: RawDraft[];
    me: RawUser;
    pr: FoundPr;
    /** GitLab does not date draft notes; they carry the time they were read. */
    draftedAt: string;
}): PrThread[] {
    const threads: PrThread[] = [];
    const byId = new Map<string, PrThread>();

    for (const discussion of discussions) {
        const notes = (discussion.notes ?? []).filter((note) => !note.system);
        const first = notes[0];
        const anchor = gitlabPosition(first?.position);

        if (!first || !anchor) {
            continue;
        }

        const headSha = first.position?.head_sha ?? undefined;
        const thread: PrThread = {
            id: discussion.id,
            ...anchor,
            commitSha: headSha,
            outdated: Boolean(headSha && pr.headSha && headSha !== pr.headSha),
            resolved: Boolean(first.resolved),
            resolvable: Boolean(first.resolvable),
            comments: notes.map((note) => ({
                id: String(note.id),
                author: author(note.author, pr.author),
                bodyMarkdown: note.body ?? "",
                createdAt: note.created_at ?? "",
                isDraft: false,
            })),
        };
        threads.push(thread);
        byId.set(thread.id, thread);
    }

    for (const draft of drafts) {
        const comment: ThreadComment = {
            id: String(draft.id),
            author: author(me, pr.author),
            bodyMarkdown: draft.note ?? "",
            createdAt: draftedAt,
            isDraft: true,
        };
        const parent = draft.discussion_id ? byId.get(draft.discussion_id) : undefined;

        if (parent) {
            parent.comments.push(comment);
            continue;
        }

        const anchor = gitlabPosition(draft.position);

        if (!anchor) {
            continue;
        }

        threads.push({
            id: `${DRAFT_THREAD_PREFIX}${draft.id}`,
            ...anchor,
            commitSha: draft.position?.head_sha ?? undefined,
            outdated: false,
            resolved: false,
            resolvable: false,
            comments: [comment],
        });
    }

    return threads;
}

function draftNumber(draftId: string): number {
    const id = Number(draftId);

    if (!Number.isInteger(id) || id < 1) {
        throw new HubPrError("bad-input", `a GitLab draft id is a positive number, got "${draftId}"`);
    }

    return id;
}

function mustSucceed(result: { ok: boolean; error?: string }, what: string): void {
    if (!result.ok) {
        throw new HubPrError("provider", `${what} failed: ${result.error ?? "unknown error"}`);
    }
}

export function gitlabBackend({ pr, api }: { pr: FoundPr; api: ProjectApi }): PrBackend {
    const iid = String(pr.number);
    const mrPath = `${projectBase(api)}/merge_requests/${iid}`;

    /** A draft on the line (or range) of the MR diff; its id. The file must be changed in the MR. */
    async function positionedDraft(input: DraftAddInput): Promise<number> {
        const files = await fetchMrDiffs(api, pr.number);
        const file = files.find((candidate) => candidate.path === input.path || candidate.oldPath === input.path);

        if (!file) {
            throw new HubPrError("bad-input", `${input.path} is not changed in !${iid}`);
        }

        const position = diffLinePosition({
            file,
            side: input.side,
            line: input.line,
            startLine: input.startLine,
        });

        if (typeof position === "string") {
            throw new HubPrError("bad-input", position);
        }

        const written = await writePositionedDraft(api, { iid, body: input.body, position });
        mustSucceed(written, "draft");

        if (written.draftId === undefined) {
            throw new HubPrError("provider", "GitLab created the draft without an id");
        }

        return written.draftId;
    }

    return {
        async threads() {
            const [discussions, drafts, me] = await Promise.all([
                restGetPaginated<RawDiscussion>(api, `${mrPath}/discussions`),
                restGetPaginated<RawDraft>(api, `${mrPath}/draft_notes`),
                restGet<RawUser>(api, "/user"),
            ]);
            const threads = gitlabThreads({ discussions, drafts, me, pr, draftedAt: new Date().toISOString() });
            log.debug(
                { iid, discussions: discussions.length, drafts: drafts.length, threads: threads.length },
                "gitlab: review threads"
            );
            return { threads, draftCount: drafts.length, viewer: me.username ?? null };
        },

        async reply({ threadId, body, draft }) {
            if (threadId.startsWith(DRAFT_THREAD_PREFIX)) {
                throw new HubPrError("bad-input", "a draft thread takes no replies until it is published");
            }

            if (draft) {
                const written = await writeDraftReply(api, { iid, discussionId: threadId, body });
                mustSucceed(written, "draft reply");
                return { threadId, commentId: String(written.draftId), isDraft: true };
            }

            const posted = await postReplyNow(api, { iid, discussionId: threadId, body });
            mustSucceed(posted, "reply");
            return { threadId, commentId: String(posted.noteId), isDraft: false };
        },

        async draftAdd(input: DraftAddInput) {
            const draftId = await positionedDraft(input);
            return { draftId: String(draftId), threadId: `${DRAFT_THREAD_PREFIX}${draftId}` };
        },

        async comment(input: DraftAddInput) {
            // Drafted first, so GitLab proves the anchor before anyone sees it; then only this draft
            // is published (never bulk_publish, which would send every other pending draft too).
            const draftId = await positionedDraft(input);
            const published = await publishDraftNote(api, iid, draftId);

            if (!published.ok) {
                const removed = await deleteDraft(api, iid, draftId);
                throw new HubPrError(
                    "provider",
                    `publish failed: ${published.error ?? "unknown error"}; ${removed.ok ? "the draft was deleted again" : `draft ${draftId} is still pending (${removed.error})`}`
                );
            }

            log.info({ iid, path: input.path, line: input.line }, "gitlab: comment published");
            return { published: true };
        },

        async draftUpdate({ draftId, body }) {
            const updated = await updateDraftNote(api, { iid, draftId: draftNumber(draftId), body });
            mustSucceed(updated, "draft update");
            return { draftId };
        },

        async draftDelete(draftId) {
            mustSucceed(await deleteDraft(api, iid, draftNumber(draftId)), "draft delete");
            return { draftId, deleted: true };
        },

        async resolve({ threadId, resolved }) {
            if (threadId.startsWith(DRAFT_THREAD_PREFIX)) {
                throw new HubPrError("bad-input", "a draft thread cannot be resolved until it is published");
            }

            mustSucceed(await resolveDiscussion(api, { iid, discussionId: threadId, resolved }), "resolve");
            return { threadId, resolved };
        },

        async publish({ event, body }: { event: PublishEvent; body?: string }) {
            if (event === "REQUEST_CHANGES") {
                throw new HubPrError("unsupported", "GitLab has no request-changes review; publish, then comment");
            }

            if (body?.trim()) {
                mustSucceed(await writeTopLevelDraft(api, iid, body), "review summary draft");
            }

            const drafts = await fetchDrafts(api, iid);

            if (drafts.length === 0 && event === "COMMENT") {
                throw new HubPrError("bad-input", "no draft notes to publish");
            }

            if (drafts.length > 0) {
                mustSucceed(await publishAllDrafts(api, iid), "bulk publish");
            }

            if (event === "APPROVE") {
                try {
                    await restWrite<void>(api, { method: "POST", path: `${mrPath}/approve` });
                } catch (error) {
                    throw new HubPrError("provider", `drafts published, approve failed: ${errorMessage(error)}`);
                }
            }

            log.info({ iid, event, drafts: drafts.length }, "gitlab: review published");
            return { event, published: drafts.length };
        },
    };
}
