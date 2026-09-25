import { getOctokit } from "@genesiscz/utils/github/octokit";
import { logger } from "@genesiscz/utils/logger";

/**
 * Writing to a PR's review: a reply in an existing thread, or a new comment on a line; either as a
 * pending review draft (only the author sees it until the review is submitted) or published at once.
 * The GitHub half of what `tools gitlab draft-reply` does for GitLab, used by the hub's review window.
 */

/** The two GitHub API calls this module makes; injected in tests. */
export interface ReviewCommentClient {
    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
    createReviewComment(input: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        path: string;
        line: number;
        side: "LEFT" | "RIGHT";
        start_line?: number;
        start_side?: "LEFT" | "RIGHT";
        body: string;
    }): Promise<{ id: number; html_url: string }>;
}

export function defaultReviewCommentClient(): ReviewCommentClient {
    const octokit = getOctokit();
    return {
        graphql: (query, variables) => octokit.graphql(query, variables),
        async createReviewComment(input) {
            const { data } = await octokit.rest.pulls.createReviewComment(input);
            return { id: data.id, html_url: data.html_url };
        },
    };
}

export interface ReviewCommentInput {
    owner: string;
    repo: string;
    number: number;
    body: string;
    /** A reply in this review thread (a `PRRT_…` node id). Otherwise `path` + `line` start a new thread. */
    threadId?: string;
    path?: string;
    line?: number;
    /** RIGHT = the new side of the diff (the default), LEFT = the old side. */
    side?: "LEFT" | "RIGHT";
    /** First line of a multi-line comment; `line` is the last. Its side defaults to `side`. */
    startLine?: number;
    startSide?: "LEFT" | "RIGHT";
    /** true: published at once. false: added to the viewer's pending review (created when missing). */
    publish: boolean;
}

export interface ReviewCommentResult {
    kind: "reply" | "comment";
    publish: boolean;
    /** The pending review the draft went into (drafts only). */
    reviewId?: string;
    commentId: string;
    /** The review thread the comment is in (drafted new comments and replies). */
    threadId?: string;
    url?: string;
}

interface PullRequestFacts {
    viewer: { login: string };
    repository: {
        pullRequest: {
            id: string;
            headRefOid: string;
            reviews: { nodes: Array<{ id: string; author: { login: string } | null }> };
        } | null;
    };
}

const FACTS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      headRefOid
      reviews(first: 20, states: PENDING) { nodes { id author { login } } }
    }
  }
}`;

const START_REVIEW = `
mutation($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOID}) {
    pullRequestReview { id }
  }
}`;

const ADD_THREAD = `
mutation($reviewId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $reviewId, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body}) {
    thread { id comments(first: 1) { nodes { id url } } }
  }
}`;

const REPLY = `
mutation($threadId: ID!, $body: String!, $reviewId: ID) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body, pullRequestReviewId: $reviewId}) {
    comment { id url }
  }
}`;

async function pullRequestFacts(client: ReviewCommentClient, input: ReviewCommentInput) {
    const facts = await client.graphql<PullRequestFacts>(FACTS_QUERY, {
        owner: input.owner,
        repo: input.repo,
        number: input.number,
    });
    const pr = facts.repository.pullRequest;

    if (!pr) {
        throw new Error(`${input.owner}/${input.repo}#${input.number} is not a pull request`);
    }

    return { pr, viewer: facts.viewer.login };
}

async function viewersPendingReview(client: ReviewCommentClient, input: ReviewCommentInput) {
    const { pr, viewer } = await pullRequestFacts(client, input);
    return { pr, mine: pr.reviews.nodes.find((review) => review.author?.login === viewer) };
}

/**
 * The viewer's pending review on the PR, started when there is none (GitHub allows one per person).
 * Two sends close together can both find none; the one that loses the start uses the winner's.
 */
async function pendingReview(client: ReviewCommentClient, input: ReviewCommentInput): Promise<string> {
    const { pr, mine } = await viewersPendingReview(client, input);

    if (mine) {
        return mine.id;
    }

    try {
        const started = await client.graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
            START_REVIEW,
            {
                pullRequestId: pr.id,
                commitOID: pr.headRefOid,
            }
        );
        logger.debug({ pr: input.number }, "github: started a pending review for a draft comment");
        return started.addPullRequestReview.pullRequestReview.id;
    } catch (error) {
        const winner = (await viewersPendingReview(client, input)).mine;

        if (!winner) {
            throw error;
        }

        logger.debug({ pr: input.number, error }, "github: another send started the pending review first; using it");
        return winner.id;
    }
}

/**
 * GitHub can refuse a published line comment with 422 "can only have one pending review per pull
 * request" while the viewer holds a pending review. That text alone does not say what to do.
 */
function explainPendingConflict(error: unknown, input: ReviewCommentInput): unknown {
    const message = error instanceof Error ? error.message : String(error);

    if (!/one pending review/i.test(message)) {
        return error;
    }

    return new Error(
        `GitHub refused the comment because you have a pending review on ${input.owner}/${input.repo}#${input.number}: submit or discard it on GitHub first, or add this comment to it as a draft (without --now)`,
        { cause: error }
    );
}

const THREAD_PULL_REQUEST = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }
  }
}`;

/**
 * The reply mutation takes only the thread id, so a thread of ANOTHER pull request would be
 * written to while the caller shows this one. The thread's own PR must be the one named.
 */
async function assertThreadOnPullRequest(client: ReviewCommentClient, input: ReviewCommentInput): Promise<void> {
    const found = await client.graphql<{
        node: { pullRequest?: { number: number; repository: { nameWithOwner: string } } } | null;
    }>(THREAD_PULL_REQUEST, { threadId: input.threadId });
    const owner = found.node?.pullRequest;
    const wanted = `${input.owner}/${input.repo}`;

    if (!owner) {
        throw new Error(`${input.threadId} is not a review thread`);
    }

    if (owner.number !== input.number || owner.repository.nameWithOwner.toLowerCase() !== wanted.toLowerCase()) {
        throw new Error(
            `thread ${input.threadId} belongs to ${owner.repository.nameWithOwner}#${owner.number}, not ${wanted}#${input.number}`
        );
    }
}

export async function postReviewComment(
    input: ReviewCommentInput,
    client: ReviewCommentClient = defaultReviewCommentClient()
): Promise<ReviewCommentResult> {
    const body = input.body.trim();

    if (!body) {
        throw new Error("the comment is empty");
    }

    // A NaN passes every range comparison and is sent as null: GitHub then makes a one-line comment.
    for (const [flag, value] of [
        ["--line", input.line],
        ["--start-line", input.startLine],
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
            throw new Error(`${flag} must be a positive whole number, got ${value}`);
        }
    }

    const side = input.side ?? "RIGHT";
    const range =
        input.startLine !== undefined && input.startLine !== input.line
            ? { startLine: input.startLine, startSide: input.startSide ?? side }
            : null;

    if (range && (!input.line || range.startLine > input.line)) {
        throw new Error(`--start-line must be between 1 and --line, got ${range.startLine}`);
    }

    if (input.threadId) {
        await assertThreadOnPullRequest(client, input);
        const reviewId = input.publish ? undefined : await pendingReview(client, input);
        const reply = await client.graphql<{
            addPullRequestReviewThreadReply: { comment: { id: string; url: string } };
        }>(REPLY, { threadId: input.threadId, body, reviewId: reviewId ?? null });
        logger.info({ pr: input.number, thread: input.threadId, publish: input.publish }, "github: review reply");
        return {
            kind: "reply",
            publish: input.publish,
            reviewId,
            threadId: input.threadId,
            commentId: reply.addPullRequestReviewThreadReply.comment.id,
            url: reply.addPullRequestReviewThreadReply.comment.url,
        };
    }

    if (!input.path || !input.line || input.line < 1) {
        throw new Error("a new comment needs --file and --line (or --thread to reply)");
    }

    if (input.publish) {
        const { pr } = await pullRequestFacts(client, input);
        const created = await client
            .createReviewComment({
                owner: input.owner,
                repo: input.repo,
                pull_number: input.number,
                commit_id: pr.headRefOid,
                path: input.path,
                line: input.line,
                side,
                ...(range ? { start_line: range.startLine, start_side: range.startSide } : {}),
                body,
            })
            .catch((error: unknown) => {
                throw explainPendingConflict(error, input);
            });
        logger.info({ pr: input.number, path: input.path, line: input.line }, "github: review comment posted");
        return { kind: "comment", publish: true, commentId: String(created.id), url: created.html_url };
    }

    const reviewId = await pendingReview(client, input);
    const thread = await client.graphql<{
        addPullRequestReviewThread: { thread: { id: string; comments: { nodes: Array<{ id: string; url: string }> } } };
    }>(ADD_THREAD, {
        reviewId,
        path: input.path,
        line: input.line,
        side,
        startLine: range?.startLine ?? null,
        startSide: range?.startSide ?? null,
        body,
    });
    const first = thread.addPullRequestReviewThread.thread.comments.nodes[0];
    logger.info({ pr: input.number, path: input.path, line: input.line }, "github: review comment drafted");
    return {
        kind: "comment",
        publish: false,
        reviewId,
        commentId: first?.id ?? thread.addPullRequestReviewThread.thread.id,
        threadId: thread.addPullRequestReviewThread.thread.id,
        url: first?.url,
    };
}
