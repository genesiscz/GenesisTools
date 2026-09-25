import { postReviewComment, type ReviewCommentClient, type ReviewCommentInput } from "@app/github/lib/review-comments";
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
 * The GitHub half of `tools hub pr`: review threads with positions, drafts in the viewer's pending
 * review, and `publish`, which submits that review. Every call goes through `client.graphql` (or
 * `postReviewComment`, which uses the same client), so a test fake sees all of them.
 */

const log = logger.child({ component: "hub/pr/github" });

const REACTION_EMOJI: Record<string, string> = {
    THUMBS_UP: "👍",
    THUMBS_DOWN: "👎",
    LAUGH: "😄",
    HOORAY: "🎉",
    CONFUSED: "😕",
    HEART: "❤️",
    ROCKET: "🚀",
    EYES: "👀",
};

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated viewerCanResolve viewerCanUnresolve
          path diffSide startDiffSide line startLine originalLine originalStartLine
          comments(first: 100) {
            nodes {
              id body createdAt lastEditedAt state authorAssociation diffHunk
              commit { oid } originalCommit { oid }
              author { login avatarUrl ... on User { name } }
              reactionGroups { content viewerHasReacted reactors { totalCount } }
            }
          }
        }
      }
    }
  }
}`;

const PENDING_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id headRefOid
      reviews(first: 20, states: PENDING) { nodes { id author { login } comments { totalCount } } }
    }
  }
}`;

const COMMENT_QUERY = `
query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewComment { id state viewerCanUpdate viewerCanDelete } }
}`;

const UPDATE_COMMENT = `
mutation($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) {
    pullRequestReviewComment { id }
  }
}`;

const DELETE_COMMENT = `
mutation($id: ID!) {
  deletePullRequestReviewComment(input: {id: $id}) { clientMutationId }
}`;

const RESOLVE_THREAD = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`;

const UNRESOLVE_THREAD = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`;

/** 🛑 The one mutation that publishes drafts. Only `publish` sends it. */
export const SUBMIT_REVIEW = `
mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: $event, body: $body}) {
    pullRequestReview { id url }
  }
}`;

/** 🛑 A review created WITH an event is published at once. Only `publish` sends it (no drafts, verdict only). */
export const CREATE_SUBMITTED_REVIEW = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event, body: $body}) {
    pullRequestReview { id url }
  }
}`;

interface RawComment {
    id: string;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    state: "PENDING" | "SUBMITTED";
    authorAssociation: string | null;
    diffHunk: string | null;
    commit: { oid: string } | null;
    originalCommit: { oid: string } | null;
    author: { login: string; avatarUrl?: string; name?: string | null } | null;
    reactionGroups: Array<{ content: string; viewerHasReacted: boolean; reactors: { totalCount: number } }> | null;
}

interface RawThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    viewerCanResolve: boolean;
    viewerCanUnresolve: boolean;
    path: string;
    diffSide: "LEFT" | "RIGHT";
    startDiffSide: "LEFT" | "RIGHT" | null;
    line: number | null;
    startLine: number | null;
    originalLine: number | null;
    originalStartLine: number | null;
    comments: { nodes: RawComment[] };
}

interface ThreadsPage {
    viewer: { login: string };
    repository: {
        pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawThread[] };
        } | null;
    };
}

interface PendingFacts {
    viewer: { login: string };
    repository: {
        pullRequest: {
            id: string;
            headRefOid: string;
            reviews: {
                nodes: Array<{ id: string; author: { login: string } | null; comments: { totalCount: number } }>;
            };
        } | null;
    };
}

function toComment(raw: RawComment): ThreadComment {
    const reactions = (raw.reactionGroups ?? [])
        .filter((group) => group.reactors.totalCount > 0)
        .map((group) => ({
            emoji: REACTION_EMOJI[group.content] ?? group.content,
            count: group.reactors.totalCount,
            mine: group.viewerHasReacted,
        }));
    return {
        id: raw.id,
        author: {
            name: raw.author?.name || raw.author?.login || "ghost",
            username: raw.author?.login ?? "ghost",
            avatarUrl: raw.author?.avatarUrl,
            role: raw.authorAssociation ?? undefined,
        },
        bodyMarkdown: raw.body,
        createdAt: raw.createdAt,
        editedAt: raw.lastEditedAt ?? undefined,
        isDraft: raw.state === "PENDING",
        reactions: reactions.length > 0 ? reactions : undefined,
    };
}

/**
 * GitHub's thread position as the window's: RIGHT = additions, LEFT = deletions. An outdated thread
 * has no current `line`, so it falls back to where it was written (`originalLine`) with its hunk.
 */
export function githubThread(raw: RawThread): PrThread {
    const first = raw.comments.nodes[0];
    const line = raw.line ?? raw.originalLine ?? 0;
    const startLine = raw.line === null ? raw.originalStartLine : raw.startLine;
    return {
        id: raw.id,
        path: raw.path,
        side: raw.diffSide === "LEFT" ? "deletions" : "additions",
        line,
        startLine: startLine !== null && startLine !== line ? startLine : undefined,
        commitSha: (raw.isOutdated ? first?.originalCommit?.oid : first?.commit?.oid) ?? undefined,
        outdated: raw.isOutdated,
        resolved: raw.isResolved,
        resolvable: raw.isResolved ? raw.viewerCanUnresolve : raw.viewerCanResolve,
        comments: raw.comments.nodes.map(toComment),
        diffHunk: first?.diffHunk ?? undefined,
    };
}

function ownerRepo(pr: FoundPr): { owner: string; repo: string } {
    const [owner, ...rest] = pr.project.split("/");
    const repo = rest.join("/");

    if (!owner || !repo) {
        throw new HubPrError("bad-input", `not an owner/repo project: ${pr.project}`);
    }

    return { owner, repo };
}

export function githubBackend({ pr, client }: { pr: FoundPr; client: ReviewCommentClient }): PrBackend {
    const { owner, repo } = ownerRepo(pr);
    const vars = { owner, repo, number: pr.number };

    async function pendingFacts() {
        const facts = await client.graphql<PendingFacts>(PENDING_QUERY, vars);
        const pull = facts.repository.pullRequest;

        if (!pull) {
            throw new HubPrError("not-found", `${pr.project}#${pr.number} is not a pull request`);
        }

        const mine = pull.reviews.nodes.find((review) => review.author?.login === facts.viewer.login) ?? null;
        return { pull, mine, viewer: facts.viewer.login };
    }

    /** Refuses an id that is not one of my pending review comments: a published comment is not a draft. */
    async function assertDraft(draftId: string): Promise<void> {
        const found = await client.graphql<{
            node: { id?: string; state?: string; viewerCanUpdate?: boolean; viewerCanDelete?: boolean } | null;
        }>(COMMENT_QUERY, { id: draftId });

        if (!found.node?.id) {
            throw new HubPrError("not-found", `no review comment ${draftId}`);
        }

        if (found.node.state !== "PENDING") {
            throw new HubPrError("not-a-draft", `${draftId} is already published; only pending drafts change here`);
        }
    }

    const base = { owner, repo, number: pr.number };
    const lineComment = (input: DraftAddInput, publish: boolean): ReviewCommentInput => ({
        ...base,
        body: input.body,
        path: input.path,
        line: input.line,
        side: input.side === "deletions" ? "LEFT" : "RIGHT",
        startLine: input.startLine,
        publish,
    });

    return {
        async threads() {
            const threads: PrThread[] = [];
            let cursor: string | null = null;
            let viewer: string | null = null;

            do {
                const page: ThreadsPage = await client.graphql<ThreadsPage>(THREADS_QUERY, { ...vars, cursor });
                const connection = page.repository.pullRequest?.reviewThreads;

                if (!connection) {
                    throw new HubPrError("not-found", `${pr.project}#${pr.number} is not a pull request`);
                }

                viewer = page.viewer.login;
                threads.push(...connection.nodes.map(githubThread));
                cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
            } while (cursor);

            const draftCount = threads.reduce(
                (sum, thread) => sum + thread.comments.filter((comment) => comment.isDraft).length,
                0
            );
            log.debug({ pr: pr.number, threads: threads.length, draftCount }, "github: review threads");
            return { threads, draftCount, viewer };
        },

        async reply({ threadId, body, draft }) {
            const result = await postReviewComment({ ...base, body, threadId, publish: !draft }, client);
            return { threadId, commentId: result.commentId, isDraft: draft, url: result.url };
        },

        async draftAdd(input: DraftAddInput) {
            const result = await postReviewComment(lineComment(input, false), client);
            return { draftId: result.commentId, threadId: result.threadId };
        },

        async comment(input: DraftAddInput) {
            const result = await postReviewComment(lineComment(input, true), client);
            log.info({ pr: pr.number, path: input.path, line: input.line }, "github: comment published");
            return { published: true, commentId: result.commentId, url: result.url };
        },

        async draftUpdate({ draftId, body }) {
            await assertDraft(draftId);
            await client.graphql(UPDATE_COMMENT, { id: draftId, body });
            log.info({ pr: pr.number, draftId }, "github: draft updated");
            return { draftId };
        },

        async draftDelete(draftId) {
            await assertDraft(draftId);
            await client.graphql(DELETE_COMMENT, { id: draftId });
            log.info({ pr: pr.number, draftId }, "github: draft deleted");
            return { draftId, deleted: true };
        },

        async resolve({ threadId, resolved }) {
            const done = await client.graphql<{
                resolveReviewThread?: { thread: { isResolved: boolean } };
                unresolveReviewThread?: { thread: { isResolved: boolean } };
            }>(resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId });
            const thread = (done.resolveReviewThread ?? done.unresolveReviewThread)?.thread;
            log.info({ pr: pr.number, threadId, resolved }, "github: thread resolution changed");
            return { threadId, resolved: thread?.isResolved ?? resolved };
        },

        async publish({ event, body }: { event: PublishEvent; body?: string }) {
            const { pull, mine } = await pendingFacts();

            if (mine) {
                const submitted = await client.graphql<{
                    submitPullRequestReview: { pullRequestReview: { id: string; url: string } };
                }>(SUBMIT_REVIEW, { reviewId: mine.id, event, body: body ?? null });
                log.info({ pr: pr.number, event, drafts: mine.comments.totalCount }, "github: review submitted");
                return {
                    event,
                    published: mine.comments.totalCount,
                    reviewId: submitted.submitPullRequestReview.pullRequestReview.id,
                    url: submitted.submitPullRequestReview.pullRequestReview.url,
                };
            }

            if (event === "COMMENT" && !body?.trim()) {
                throw new HubPrError("bad-input", "no pending drafts to publish; add a draft or pass --body-file");
            }

            const created = await client.graphql<{
                addPullRequestReview: { pullRequestReview: { id: string; url: string } };
            }>(CREATE_SUBMITTED_REVIEW, {
                pullRequestId: pull.id,
                commitOID: pull.headRefOid,
                event,
                body: body ?? null,
            });
            log.info({ pr: pr.number, event }, "github: review submitted without drafts");
            return {
                event,
                published: 0,
                reviewId: created.addPullRequestReview.pullRequestReview.id,
                url: created.addPullRequestReview.pullRequestReview.url,
            };
        },
    };
}
