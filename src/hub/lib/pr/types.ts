import type { OriginKind, PrState } from "@genesiscz/utils/git/origins";

/** The PR/MR a verb works on: the checked-out branch's (`tools hub pr find`), or the one `--pr` names. */
export interface FoundPr {
    provider: OriginKind;
    /** Host as the CLIs want it, a port included (`github.com`, `gitlab.example.com`). */
    host: string;
    /** `owner/repo` on GitHub, `group/sub/project` on GitLab. */
    project: string;
    number: number;
    url: string;
    webUrl: string;
    title: string;
    state: PrState;
    draft: boolean;
    author: string | null;
    sourceBranch: string;
    targetBranch: string;
    headSha: string | null;
    baseSha: string | null;
    /** The head branch lives in another project (a fork). */
    crossRepository: boolean;
    /** That project's path (`owner/repo`) on the same host; null for a same-project PR or when the host did not say. */
    headRepo: string | null;
    /** The checkout the branch was read from; null for a PR named by URL. */
    repoPath: string | null;
}

/** `provider: null` is an answer, not a failure: there is no PR/MR, or no host this tool can ask. */
export interface NoPr {
    provider: null;
    reason: string;
    branch: string | null;
    repoPath: string;
}

export type FindResult = FoundPr | NoPr;

/** RIGHT / new side = additions, LEFT / old side = deletions (the review window's words). */
export type ThreadSide = "additions" | "deletions";
export const THREAD_SIDES: readonly ThreadSide[] = ["additions", "deletions"];

export interface ThreadAuthor {
    name: string;
    username: string;
    avatarUrl?: string;
    /** GitHub's author association (OWNER, MEMBER, CONTRIBUTOR…); `author` on GitLab for the MR's author. */
    role?: string;
}

export interface ThreadComment {
    /** GitHub comment node id; GitLab note id, or the draft note id when `isDraft`. */
    id: string;
    author: ThreadAuthor;
    bodyMarkdown: string;
    createdAt: string;
    editedAt?: string;
    /** My pending review comment (GitHub) or draft note (GitLab); only I can see it until `publish`. */
    isDraft: boolean;
    reactions?: Array<{ emoji: string; count: number; mine: boolean }>;
}

export interface PrThread {
    /** GitHub `PRRT_…` thread id or GitLab discussion id; `draft-<id>` for a GitLab draft that starts a thread. */
    id: string;
    path: string;
    oldPath?: string;
    side: ThreadSide;
    /** End line on `side`. */
    line: number;
    startLine?: number;
    /** The commit the position refers to. */
    commitSha?: string;
    /** The position is no longer in the current diff (GitHub), or was placed on an older head (GitLab). */
    outdated: boolean;
    resolved: boolean;
    resolvable: boolean;
    comments: ThreadComment[];
    diffHunk?: string;
}

export interface ThreadsResult {
    pr: FoundPr;
    threads: PrThread[];
    /** Every draft `publish` would send, including GitLab drafts with no line (not shown as threads). */
    draftCount: number;
    /** The logged-in user on the host. */
    viewer: string | null;
    /** Served from the 30 s cache. */
    cached: boolean;
    fetchedAt: string;
}

export interface ReplyResult {
    threadId: string;
    commentId: string;
    isDraft: boolean;
    url?: string;
}

export interface DraftAddInput {
    path: string;
    side: ThreadSide;
    line: number;
    startLine?: number;
    body: string;
}

export interface DraftAddResult {
    /** Store this as the proposal draft's `providerId`: `draft update|delete` take it. */
    draftId: string;
    threadId?: string;
}

/** A new comment published at once, alone: no other pending draft goes out with it. */
export interface CommentResult {
    published: true;
    /** GitHub's comment id; GitLab answers a single publish with no note id. */
    commentId?: string;
    url?: string;
}

export type PublishEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PublishResult {
    event: PublishEvent;
    /** Drafts that went out with this review. */
    published: number;
    reviewId?: string;
    url?: string;
}

/** Everything the hub's review window does to a PR/MR. Only `publish` submits the pending drafts. */
export interface PrBackend {
    threads(): Promise<Omit<ThreadsResult, "pr" | "cached" | "fetchedAt">>;
    reply(input: { threadId: string; body: string; draft: boolean }): Promise<ReplyResult>;
    draftAdd(input: DraftAddInput): Promise<DraftAddResult>;
    /** Publishes this one comment at once; the pending drafts stay pending. */
    comment(input: DraftAddInput): Promise<CommentResult>;
    draftUpdate(input: { draftId: string; body: string }): Promise<{ draftId: string }>;
    draftDelete(draftId: string): Promise<{ draftId: string; deleted: true }>;
    resolve(input: { threadId: string; resolved: boolean }): Promise<{ threadId: string; resolved: boolean }>;
    publish(input: { event: PublishEvent; body?: string }): Promise<PublishResult>;
}

export type HubPrErrorCode = "no-pr" | "bad-input" | "not-found" | "not-a-draft" | "unsupported" | "provider";

/** A failure the window shows as-is: `--json` prints `{ error, code }` and the command exits 1. */
export class HubPrError extends Error {
    constructor(
        readonly code: HubPrErrorCode,
        message: string
    ) {
        super(message);
    }
}
