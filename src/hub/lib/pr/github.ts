import { postReviewComment, type ReviewCommentClient, type ReviewCommentInput } from "@app/github/lib/review-comments";
import { logger } from "@genesiscz/utils/logger";
import {
    type DraftAddInput,
    type FoundPr,
    HubPrError,
    type PrBackend,
    type PrThread,
    type PrVersion,
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
              id url body createdAt lastEditedAt state authorAssociation diffHunk
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

const FORCE_PUSH_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      timelineItems(last: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        nodes { ... on HeadRefForcePushedEvent {
          createdAt
          actor { login avatarUrl ... on User { name } }
          beforeCommit { oid }
          afterCommit { oid }
        } }
      }
    }
  }
}`;

interface ForcePush {
    createdAt?: string;
    actor?: { login?: string; avatarUrl?: string; name?: string | null } | null;
    beforeCommit?: { oid?: string } | null;
    afterCommit?: { oid?: string } | null;
}

/**
 * GitHub keeps no diff versions; its force pushes are the versions a rebase replaced. Newest first:
 * the current head, then each force push's after-commit, then the oldest push's before-commit. A
 * base is not known here: the window takes the merge base with the target branch.
 */
export function githubVersions({ headSha, pushes }: { headSha: string | null; pushes: ForcePush[] }): PrVersion[] {
    const newest = [...pushes]
        .filter((push) => push.afterCommit?.oid)
        .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    const versions: PrVersion[] = [];
    const seen = new Set<string>();
    const add = (version: PrVersion) => {
        if (version.headSha && !seen.has(version.headSha)) {
            seen.add(version.headSha);
            versions.push(version);
        }
    };

    for (const [index, push] of newest.entries()) {
        const actor = push.actor?.login
            ? { name: push.actor.name || push.actor.login, username: push.actor.login, avatarUrl: push.actor.avatarUrl }
            : null;

        if (index === 0 && headSha && headSha !== push.afterCommit?.oid) {
            add({ id: "head", headSha, baseSha: null, createdAt: null, pushedBy: null, commits: [] });
        }

        add({
            id: push.afterCommit?.oid ?? "",
            headSha: push.afterCommit?.oid ?? "",
            baseSha: null,
            createdAt: push.createdAt ?? null,
            pushedBy: actor,
            commits: [],
        });
    }

    if (versions.length === 0 && headSha) {
        add({ id: "head", headSha, baseSha: null, createdAt: null, pushedBy: null, commits: [] });
    }

    const oldest = newest.at(-1)?.beforeCommit?.oid;

    if (oldest) {
        add({ id: oldest, headSha: oldest, baseSha: null, createdAt: null, pushedBy: null, commits: [] });
    }

    return versions;
}

const COMMENT_QUERY = `
query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewComment {
    id state viewerCanUpdate viewerCanDelete
    pullRequest { number repository { nameWithOwner } }
  } }
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
    pullRequestReview {
      id url
      comments(first: 100) { nodes { id } pageInfo { hasNextPage endCursor } }
    }
  }
}`;

interface SubmittedComments {
    nodes: Array<{ id: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const SUBMITTED_COMMENTS_QUERY = `
query($id: ID!, $cursor: String!) {
  node(id: $id) { ... on PullRequestReview {
    comments(first: 100, after: $cursor) { nodes { id } pageInfo { hasNextPage endCursor } }
  } }
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
    url?: string | null;
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
        url: raw.state === "PENDING" ? undefined : (raw.url ?? undefined),
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
            node: {
                id?: string;
                state?: string;
                viewerCanUpdate?: boolean;
                viewerCanDelete?: boolean;
                pullRequest?: { number: number; repository: { nameWithOwner: string } };
            } | null;
        }>(COMMENT_QUERY, { id: draftId });

        if (!found.node?.id) {
            throw new HubPrError("not-found", `no review comment ${draftId}`);
        }

        const owner = found.node.pullRequest;

        if (owner?.number !== pr.number || owner.repository.nameWithOwner.toLowerCase() !== pr.project.toLowerCase()) {
            throw new HubPrError("bad-input", "the draft does not belong to the selected pull request");
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
        async versions() {
            const found = await client.graphql<{
                repository: { pullRequest: { headRefOid?: string; timelineItems: { nodes: ForcePush[] } } | null };
            }>(FORCE_PUSH_QUERY, vars);
            const pull = found.repository.pullRequest;

            if (!pull) {
                throw new HubPrError("not-found", `${pr.project}#${pr.number} is not a pull request`);
            }

            const pushes = pull.timelineItems.nodes;
            return {
                versions: githubVersions({ headSha: pull.headRefOid ?? pr.headSha, pushes }),
                history: pushes.length > 0,
            };
        },
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
                    submitPullRequestReview: {
                        pullRequestReview: { id: string; url: string; comments: SubmittedComments };
                    };
                }>(SUBMIT_REVIEW, { reviewId: mine.id, event, body: body ?? null });
                const review = submitted.submitPullRequestReview.pullRequestReview;
                const submittedIds = review.comments.nodes.map((comment) => comment.id);
                let page = review.comments.pageInfo;
                let warning: string | undefined;
                const cursors = new Set<string>();

                try {
                    while (page.hasNextPage) {
                        if (!page.endCursor || cursors.has(page.endCursor)) {
                            throw new Error("Submitted comment pagination did not advance");
                        }

                        cursors.add(page.endCursor);
                        const more = await client.graphql<{ node: { comments: SubmittedComments } }>(
                            SUBMITTED_COMMENTS_QUERY,
                            { id: review.id, cursor: page.endCursor }
                        );
                        submittedIds.push(...more.node.comments.nodes.map((comment) => comment.id));
                        page = more.node.comments.pageInfo;
                    }
                } catch (error) {
                    warning =
                        "Review submitted, but some submitted comment identities could not be read; refresh before sending more.";
                    log.warn({ error, reviewId: review.id }, warning);
                }

                log.info({ pr: pr.number, event, drafts: submittedIds.length }, "github: review submitted");
                return {
                    event,
                    published: mine.comments.totalCount,
                    submittedIds,
                    pr: { provider: pr.provider, host: pr.host, project: pr.project, number: pr.number },
                    warning,
                    reviewId: review.id,
                    url: review.url,
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
                submittedIds: [],
                pr: { provider: pr.provider, host: pr.host, project: pr.project, number: pr.number },
                reviewId: created.addPullRequestReview.pullRequestReview.id,
                url: created.addPullRequestReview.pullRequestReview.url,
            };
        },
    };
}
