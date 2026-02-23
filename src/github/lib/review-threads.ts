// Shared review thread library - GraphQL queries, fetching, parsing, mutations
// Extracted from src/github-pr/index.ts, adapted to use shared octokit

import type {
    ParsedReviewThread,
    PRLevelComment,
    ReviewThread,
    ReviewThreadComment,
    ReviewThreadStats,
} from "@app/github/types";
import { getGhCliToken, getOctokit } from "@app/utils/github/octokit";
import { Octokit } from "octokit";

// =============================================================================
// GraphQL Queries
// =============================================================================

// Full query — used for the first page only (fetches reviews + comments alongside threads)
const REVIEW_THREADS_QUERY_FULL = `
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        title
        state
        reviewThreads(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              isResolved
              path
              line
              startLine
              comments(first: 50) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    author {
                      login
                    }
                    body
                    createdAt
                    diffHunk
                  }
                }
              }
            }
          }
        }
        reviews(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              author {
                login
              }
              body
              state
              createdAt
            }
          }
        }
        comments(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              author {
                login
              }
              body
              createdAt
            }
          }
        }
      }
    }
  }
`;

// Threads-only query — used for pages 2+ (omits reviews/comments already fetched)
const REVIEW_THREADS_QUERY_THREADS_ONLY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              isResolved
              path
              line
              startLine
              comments(first: 50) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    author {
                      login
                    }
                    body
                    createdAt
                    diffHunk
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $cursor: String!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              author {
                login
              }
              body
              createdAt
              diffHunk
            }
          }
        }
      }
    }
  }
`;

const PR_REVIEWS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviews(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              author {
                login
              }
              body
              state
              createdAt
            }
          }
        }
      }
    }
  }
`;

const PR_COMMENTS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              author {
                login
              }
              body
              createdAt
            }
          }
        }
      }
    }
  }
`;

// =============================================================================
// GraphQL Response Types
// =============================================================================

interface CommentNode {
    id: string;
    author: { login: string } | null;
    body: string;
    createdAt: string;
    diffHunk: string | null;
}

interface CommentsConnection {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
    };
    edges: Array<{
        node: CommentNode;
    }>;
}

interface ThreadNode {
    id: string;
    isResolved: boolean;
    path: string;
    line: number | null;
    startLine: number | null;
    comments: CommentsConnection;
}

interface ReviewNode {
    id: string;
    author: { login: string } | null;
    body: string;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
    createdAt: string;
}

interface PrCommentNode {
    id: string;
    author: { login: string } | null;
    body: string;
    createdAt: string;
}

interface PagedConnection<TNode> {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: TNode }>;
}

// Response type for REVIEW_THREADS_QUERY_FULL (first page — includes reviews + comments)
interface GraphQLResponseFull {
    repository: {
        pullRequest: {
            title: string;
            state: string;
            reviewThreads: PagedConnection<ThreadNode>;
            reviews: PagedConnection<ReviewNode>;
            comments: PagedConnection<PrCommentNode>;
        } | null;
    };
}

// Response type for REVIEW_THREADS_QUERY_THREADS_ONLY (subsequent pages)
interface GraphQLResponseThreadsOnly {
    repository: {
        pullRequest: {
            reviewThreads: PagedConnection<ThreadNode>;
        } | null;
    };
}

const PR_LEVEL_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const);
type PrLevelState = NonNullable<PRLevelComment["reviewState"]>;

function isPrLevelReviewState(s: string): s is PrLevelState {
    return PR_LEVEL_STATES.has(s as PrLevelState);
}

interface ThreadCommentsResponse {
    node: {
        comments: CommentsConnection;
    } | null;
}

interface PRReviewInfo {
    title: string;
    state: string;
    threads: ReviewThread[];
    prComments: PRLevelComment[];
}

// =============================================================================
// Fetching
// =============================================================================

interface PrReviewsPageResponse {
    repository: {
        pullRequest: {
            reviews: PagedConnection<ReviewNode>;
        } | null;
    };
}

interface PrCommentsPageResponse {
    repository: {
        pullRequest: {
            comments: PagedConnection<PrCommentNode>;
        } | null;
    };
}

/**
 * Generic helper: paginate through a PR-level GraphQL connection starting from a cursor.
 * The `getConnection` callback extracts the paged connection from the typed response.
 */
async function fetchPagedPrNodes<TNode, TResponse>(
    query: string,
    vars: { owner: string; repo: string; pr: number },
    startCursor: string,
    getConnection: (data: TResponse) => PagedConnection<TNode> | null | undefined
): Promise<TNode[]> {
    const octokit = getOctokit();
    const nodes: TNode[] = [];
    let cursor: string | null = startCursor;

    while (cursor) {
        const data = await octokit.graphql<TResponse>(query, { ...vars, cursor });
        const connection = getConnection(data);

        if (!connection) {
            break;
        }

        for (const edge of connection.edges) {
            nodes.push(edge.node);
        }

        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    }

    return nodes;
}

async function fetchAdditionalComments(threadId: string, startCursor: string): Promise<ReviewThreadComment[]> {
    const octokit = getOctokit();
    const comments: ReviewThreadComment[] = [];
    let cursor: string | null = startCursor;

    while (cursor) {
        const data: ThreadCommentsResponse = await octokit.graphql(THREAD_COMMENTS_QUERY, {
            threadId,
            cursor,
        });

        if (!data.node?.comments) {
            break;
        }

        for (const ce of data.node.comments.edges) {
            comments.push({
                id: ce.node.id,
                author: ce.node.author?.login ?? "ghost",
                body: ce.node.body,
                createdAt: ce.node.createdAt,
                diffHunk: ce.node.diffHunk,
            });
        }

        cursor = data.node.comments.pageInfo.hasNextPage ? data.node.comments.pageInfo.endCursor : null;
    }

    return comments;
}

function collectThreadPage(
    reviewThreads: PagedConnection<ThreadNode>,
    allThreads: ReviewThread[],
    threadsNeedingMoreComments: Array<{ threadIndex: number; threadId: string; commentsCursor: string }>
): void {
    for (const edge of reviewThreads.edges) {
        const node = edge.node;
        const threadIndex = allThreads.length;

        allThreads.push({
            id: node.id,
            isResolved: node.isResolved,
            path: node.path,
            line: node.line,
            startLine: node.startLine,
            comments: node.comments.edges.map((ce) => ({
                id: ce.node.id,
                author: ce.node.author?.login ?? "ghost",
                body: ce.node.body,
                createdAt: ce.node.createdAt,
                diffHunk: ce.node.diffHunk,
            })),
        });

        if (node.comments.pageInfo.hasNextPage && node.comments.pageInfo.endCursor) {
            threadsNeedingMoreComments.push({
                threadIndex,
                threadId: node.id,
                commentsCursor: node.comments.pageInfo.endCursor,
            });
        }
    }
}

/**
 * Fetch PR review threads via GraphQL with full pagination.
 * First page uses REVIEW_THREADS_QUERY_FULL (includes reviews + comments).
 * Subsequent pages use REVIEW_THREADS_QUERY_THREADS_ONLY to avoid refetching PR-level data.
 */
export async function fetchPRReviewThreads(owner: string, repo: string, prNumber: number): Promise<PRReviewInfo> {
    const octokit = getOctokit();
    const allThreads: ReviewThread[] = [];
    const prComments: PRLevelComment[] = [];
    const threadsNeedingMoreComments: Array<{
        threadIndex: number;
        threadId: string;
        commentsCursor: string;
    }> = [];

    // --- First page: fetch threads + PR-level reviews + PR-level comments ---
    const firstPage = await octokit.graphql<GraphQLResponseFull>(REVIEW_THREADS_QUERY_FULL, {
        owner,
        repo,
        pr: prNumber,
    });

    const firstPr = firstPage.repository.pullRequest;
    if (!firstPr) {
        throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
    }

    const title = firstPr.title;
    const state = firstPr.state;

    // Collect PR-level reviews (including empty-body reviews — shown as "(no review body)")
    const allReviewNodes: ReviewNode[] = [...firstPr.reviews.edges.map((e) => e.node)];
    if (firstPr.reviews.pageInfo.hasNextPage && firstPr.reviews.pageInfo.endCursor) {
        const extra = await fetchPagedPrNodes<ReviewNode, PrReviewsPageResponse>(
            PR_REVIEWS_QUERY,
            { owner, repo, pr: prNumber },
            firstPr.reviews.pageInfo.endCursor,
            (data) => data.repository?.pullRequest?.reviews
        );
        allReviewNodes.push(...extra);
    }

    for (const node of allReviewNodes) {
        if (node.state === "PENDING" || !isPrLevelReviewState(node.state)) {
            continue;
        }

        prComments.push({
            id: node.id,
            author: node.author?.login ?? "ghost",
            body: node.body.trim() || "(no review body)",
            createdAt: node.createdAt,
            type: "review",
            reviewState: node.state,
        });
    }

    // Collect PR-level conversation comments
    const allPrCommentNodes: PrCommentNode[] = [...firstPr.comments.edges.map((e) => e.node)];
    if (firstPr.comments.pageInfo.hasNextPage && firstPr.comments.pageInfo.endCursor) {
        const extra = await fetchPagedPrNodes<PrCommentNode, PrCommentsPageResponse>(
            PR_COMMENTS_QUERY,
            { owner, repo, pr: prNumber },
            firstPr.comments.pageInfo.endCursor,
            (data) => data.repository?.pullRequest?.comments
        );
        allPrCommentNodes.push(...extra);
    }

    for (const node of allPrCommentNodes) {
        if (!node.body.trim()) {
            continue;
        }

        prComments.push({
            id: node.id,
            author: node.author?.login ?? "ghost",
            body: node.body,
            createdAt: node.createdAt,
            type: "comment",
        });
    }

    // Collect first page threads
    collectThreadPage(firstPr.reviewThreads, allThreads, threadsNeedingMoreComments);

    // --- Subsequent pages: threads only (no reviews/comments) ---
    let cursor: string | null = firstPr.reviewThreads.pageInfo.hasNextPage
        ? firstPr.reviewThreads.pageInfo.endCursor
        : null;

    while (cursor) {
        const data = await octokit.graphql<GraphQLResponseThreadsOnly>(REVIEW_THREADS_QUERY_THREADS_ONLY, {
            owner,
            repo,
            pr: prNumber,
            cursor,
        });

        const pr = data.repository.pullRequest;
        if (!pr) {
            break;
        }

        collectThreadPage(pr.reviewThreads, allThreads, threadsNeedingMoreComments);
        cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
    }

    // Fetch additional inline comments for threads with more than 50 comments
    for (const { threadIndex, threadId, commentsCursor } of threadsNeedingMoreComments) {
        const additionalComments = await fetchAdditionalComments(threadId, commentsCursor);
        allThreads[threadIndex].comments.push(...additionalComments);
    }

    // Return PR-level comments in chronological order
    prComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { title, state, threads: allThreads, prComments };
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Reply to a review thread
 */
export async function replyToThread(pullRequestReviewThreadId: string, body: string): Promise<string> {
    const octokit = getOctokit();

    const query = `
    mutation($pullRequestReviewThreadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $pullRequestReviewThreadId, body: $body}) {
        comment {
          id
        }
      }
    }
  `;

    const data = await octokit.graphql<{
        addPullRequestReviewThreadReply: { comment: { id: string } };
    }>(query, {
        pullRequestReviewThreadId,
        body,
    });

    return data.addPullRequestReviewThreadReply.comment.id;
}

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread {
        isResolved
      }
    }
  }
`;

/**
 * Mark a review thread as resolved.
 * Prefers the gh CLI token (classic OAuth with repo scope) since fine-grained
 * PATs don't support the resolveReviewThread GraphQL mutation.
 * Falls back to the primary token if gh CLI is unavailable.
 */
export async function markThreadResolved(threadId: string): Promise<boolean> {
    const ghToken = getGhCliToken();
    const octokit = ghToken ? new Octokit({ auth: ghToken }) : getOctokit();
    await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    return true;
}

/**
 * Resolve multiple review threads with progress reporting.
 * Continues on individual failures, collecting failed IDs.
 * Progress reports processed count (success + failure), not just successes.
 */
export async function batchResolveThreads(
    threadIds: string[],
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ resolved: number; failed: string[] }> {
    let resolved = 0;
    let processed = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await markThreadResolved(threadId);
            resolved++;
        } catch {
            failed.push(threadId);
        }
        processed++;
        options?.onProgress?.(processed, threadIds.length);
    }

    return { resolved, failed };
}

/**
 * Reply to and resolve multiple threads with the same message.
 * If reply succeeds but resolve fails, the reply is kept and the thread
 * is added to the failed list. Progress reports processed count.
 */
export async function batchReplyAndResolve(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; resolved: number; failed: string[] }> {
    let replied = 0;
    let resolved = 0;
    let processed = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
            try {
                await markThreadResolved(threadId);
                resolved++;
            } catch {
                failed.push(threadId);
            }
        } catch {
            failed.push(threadId);
        }
        processed++;
        options?.onProgress?.(processed, threadIds.length);
    }

    return { replied, resolved, failed };
}

/**
 * Reply to multiple threads with the same message.
 * Progress reports processed count (success + failure).
 */
export async function batchReply(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; failed: string[] }> {
    let replied = 0;
    let processed = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
        } catch {
            failed.push(threadId);
        }
        processed++;
        options?.onProgress?.(processed, threadIds.length);
    }

    return { replied, failed };
}

// =============================================================================
// Thread Parsing
// =============================================================================

/**
 * Trim a diff hunk to show only context around the target line.
 * GitHub's API returns the entire file diff for new files, but we want
 * to show only ~4 lines of context around the comment line (like GitHub UI).
 */
function trimDiffHunk(
    diffHunk: string | null,
    targetLine: number | null,
    startLine: number | null = null,
    contextLines: number = 3
): string | null {
    if (!diffHunk || !targetLine) {
        return diffHunk;
    }

    const lines = diffHunk.split("\n");
    if (lines.length === 0) {
        return diffHunk;
    }

    // Parse the @@ header to get starting line number
    const headerMatch = lines[0].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!headerMatch) {
        return diffHunk;
    }

    const newStartLine = parseInt(headerMatch[2], 10);

    // Track line numbers and collect lines within the context window
    let currentLine = newStartLine;
    const relevantLines: { line: string; lineNum: number | null }[] = [];
    const rangeStart = startLine ?? targetLine;
    const minLine = rangeStart - contextLines;
    const maxLine = targetLine + contextLines;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Removed lines (-) don't have a new-file line number
        if (line.startsWith("-")) {
            if (currentLine >= minLine && currentLine <= maxLine) {
                relevantLines.push({ line, lineNum: null });
            }
            continue;
        }

        // Context and added lines have new-file line numbers
        if (currentLine >= minLine && currentLine <= maxLine) {
            relevantLines.push({ line, lineNum: currentLine });
        }

        currentLine++;
    }

    // Hard-cap at 15 content lines
    const MAX_CONTENT_LINES = 15;
    if (relevantLines.length > MAX_CONTENT_LINES) {
        const targetIdx = relevantLines.findIndex((r) => r.lineNum === targetLine);
        if (targetIdx >= 0) {
            const halfWindow = Math.floor(MAX_CONTENT_LINES / 2);
            let start = Math.max(0, targetIdx - halfWindow);
            let end = start + MAX_CONTENT_LINES;
            if (end > relevantLines.length) {
                end = relevantLines.length;
                start = Math.max(0, end - MAX_CONTENT_LINES);
            }
            relevantLines.splice(end);
            relevantLines.splice(0, start);
        } else {
            relevantLines.splice(0, relevantLines.length - MAX_CONTENT_LINES);
        }
    }

    if (relevantLines.length === 0) {
        return diffHunk;
    }

    // Build new header with separate old/new line counts
    const firstLineNum = relevantLines.find((r) => r.lineNum !== null)?.lineNum ?? targetLine;
    let oldCount = 0;
    let newCount = 0;
    for (const r of relevantLines) {
        if (r.line.startsWith("-")) {
            oldCount++;
        } else if (r.line.startsWith("+")) {
            newCount++;
        } else {
            // Context lines count in both
            oldCount++;
            newCount++;
        }
    }
    const newHeader = `@@ -${firstLineNum},${oldCount || 1} +${firstLineNum},${newCount || 1} @@`;

    return [newHeader, ...relevantLines.map((r) => r.line)].join("\n");
}

function detectSeverity(body: string): "high" | "medium" | "low" {
    const lowerBody = body.toLowerCase();

    if (
        lowerBody.includes("high-priority") ||
        lowerBody.includes("![high]") ||
        lowerBody.includes("critical") ||
        lowerBody.includes("security vulnerability") ||
        /\bbug\b/.test(lowerBody)
    ) {
        return "high";
    }

    if (
        lowerBody.includes("medium-priority") ||
        lowerBody.includes("![medium]") ||
        lowerBody.includes("suggestion") ||
        lowerBody.includes("refactor") ||
        lowerBody.includes("performance") ||
        lowerBody.includes("style")
    ) {
        return "medium";
    }

    return "low";
}

function extractTitle(body: string): string {
    const lines = body.split("\n").filter((l) => l.trim());

    // Skip image badges like ![high]
    const firstContent = lines.find((l) => !l.startsWith("!["));
    if (firstContent) {
        const cleaned = firstContent
            .replace(/^#+\s*/, "")
            .replace(/\*\*/g, "")
            .replace(/`/g, "")
            .trim();
        return cleaned.length > 60 ? `${cleaned.substring(0, 57)}...` : cleaned;
    }

    return "Review Comment";
}

function extractSuggestion(body: string): string | null {
    // GitHub suggestion format
    const suggestionMatch = body.match(/```suggestion\r?\n([\s\S]*?)```/);
    if (suggestionMatch) {
        return suggestionMatch[1];
    }

    // Code block with php/typescript etc that looks like a fix
    const codeBlockMatch = body.match(/```(?:php|typescript|ts|js|javascript)?\r?\n([\s\S]*?)```/);
    if (codeBlockMatch && (body.toLowerCase().includes("should") || body.toLowerCase().includes("instead"))) {
        return codeBlockMatch[1];
    }

    return null;
}

function extractIssue(body: string): string {
    // Only remove severity badges like ![high](url) but KEEP code examples
    return body.replace(/!\[(high|medium|low)\]\([^)]*\)/gi, "").trim();
}

/**
 * Parse raw review threads into structured format
 */
export function parseThreads(threads: ReviewThread[]): ParsedReviewThread[] {
    return threads
        .filter((thread) => thread.comments.length > 0)
        .map((thread, index) => {
            const firstComment = thread.comments[0];
            const replies = thread.comments.slice(1).map((c) => ({
                author: c.author,
                body: c.body,
                id: c.id,
            }));

            return {
                threadId: thread.id,
                threadNumber: index + 1,
                status: thread.isResolved ? "resolved" : "unresolved",
                severity: detectSeverity(firstComment.body),
                file: thread.path,
                line: thread.line,
                startLine: thread.startLine,
                author: firstComment.author,
                title: extractTitle(firstComment.body),
                issue: extractIssue(firstComment.body),
                diffHunk: trimDiffHunk(firstComment.diffHunk, thread.line, thread.startLine),
                suggestedCode: extractSuggestion(firstComment.body),
                firstCommentId: firstComment.id,
                replies,
            };
        });
}

/**
 * Calculate review thread statistics
 */
export function calculateReviewStats(threads: ParsedReviewThread[]): ReviewThreadStats {
    return {
        total: threads.length,
        resolved: threads.filter((t) => t.status === "resolved").length,
        unresolved: threads.filter((t) => t.status === "unresolved").length,
        high: threads.filter((t) => t.severity === "high").length,
        medium: threads.filter((t) => t.severity === "medium").length,
        low: threads.filter((t) => t.severity === "low").length,
    };
}
