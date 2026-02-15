// Shared review thread library - GraphQL queries, fetching, parsing, mutations
// Extracted from src/github-pr/index.ts, adapted to use shared octokit

import type { ParsedReviewThread, ReviewThread, ReviewThreadComment, ReviewThreadStats } from "@app/github/types";
import { getOctokit } from "@app/utils/github/octokit";

// =============================================================================
// GraphQL Queries
// =============================================================================

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        title
        state
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

interface GraphQLResponse {
    repository: {
        pullRequest: {
            title: string;
            state: string;
            reviewThreads: {
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
                edges: Array<{
                    node: {
                        id: string;
                        isResolved: boolean;
                        path: string;
                        line: number | null;
                        startLine: number | null;
                        comments: CommentsConnection;
                    };
                }>;
            };
        } | null;
    };
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
}

// =============================================================================
// Fetching
// =============================================================================

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

/**
 * Fetch PR review threads via GraphQL with full pagination
 */
export async function fetchPRReviewThreads(
    owner: string,
    repo: string,
    prNumber: number
): Promise<PRReviewInfo> {
    const octokit = getOctokit();
    const allThreads: ReviewThread[] = [];
    let cursor: string | null = null;
    let title = "";
    let state = "";

    // Track threads that need additional comment pages
    const threadsNeedingMoreComments: Array<{
        threadIndex: number;
        threadId: string;
        commentsCursor: string;
    }> = [];

    do {
        const data: GraphQLResponse = await octokit.graphql(REVIEW_THREADS_QUERY, {
            owner,
            repo,
            pr: prNumber,
            cursor,
        });

        const pr: GraphQLResponse["repository"]["pullRequest"] = data.repository.pullRequest;
        if (!pr) {
            throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
        }

        title = pr.title;
        state = pr.state;

        for (const edge of pr.reviewThreads.edges) {
            const node = edge.node;
            const threadIndex = allThreads.length;

            allThreads.push({
                id: node.id,
                isResolved: node.isResolved,
                path: node.path,
                line: node.line,
                startLine: node.startLine,
                comments: node.comments.edges.map((ce: { node: CommentNode }) => ({
                    id: ce.node.id,
                    author: ce.node.author?.login ?? "ghost",
                    body: ce.node.body,
                    createdAt: ce.node.createdAt,
                    diffHunk: ce.node.diffHunk,
                })),
            });

            // Check if this thread has more comments to fetch
            if (node.comments.pageInfo.hasNextPage && node.comments.pageInfo.endCursor) {
                threadsNeedingMoreComments.push({
                    threadIndex,
                    threadId: node.id,
                    commentsCursor: node.comments.pageInfo.endCursor,
                });
            }
        }

        cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
    } while (cursor);

    // Fetch additional comments for threads with more than 50 comments
    for (const { threadIndex, threadId, commentsCursor } of threadsNeedingMoreComments) {
        const additionalComments = await fetchAdditionalComments(threadId, commentsCursor);
        allThreads[threadIndex].comments.push(...additionalComments);
    }

    return { title, state, threads: allThreads };
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

/**
 * Mark a review thread as resolved
 */
export async function markThreadResolved(threadId: string): Promise<boolean> {
    const octokit = getOctokit();

    const query = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread {
          isResolved
        }
      }
    }
  `;

    await octokit.graphql(query, { threadId });
    return true;
}

/**
 * Resolve multiple review threads with progress reporting.
 * Continues on individual failures, collecting failed IDs.
 */
export async function batchResolveThreads(
    threadIds: string[],
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ resolved: number; failed: string[] }> {
    let resolved = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await markThreadResolved(threadId);
            resolved++;
            options?.onProgress?.(resolved, threadIds.length);
        } catch {
            failed.push(threadId);
        }
    }

    return { resolved, failed };
}

/**
 * Reply to and resolve multiple threads with the same message.
 * If reply succeeds but resolve fails, the reply is still kept.
 */
export async function batchReplyAndResolve(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; resolved: number; failed: string[] }> {
    let replied = 0;
    let resolved = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
            await markThreadResolved(threadId);
            resolved++;
            options?.onProgress?.(resolved, threadIds.length);
        } catch {
            failed.push(threadId);
        }
    }

    return { replied, resolved, failed };
}

/**
 * Reply to multiple threads with the same message.
 */
export async function batchReply(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; failed: string[] }> {
    let replied = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
            options?.onProgress?.(replied, threadIds.length);
        } catch {
            failed.push(threadId);
        }
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
function trimDiffHunk(diffHunk: string | null, targetLine: number | null, contextLines: number = 4): string | null {
    if (!diffHunk || !targetLine) return diffHunk;

    const lines = diffHunk.split("\n");
    if (lines.length === 0) return diffHunk;

    // Parse the @@ header to get starting line number
    const headerMatch = lines[0].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!headerMatch) return diffHunk;

    const newStartLine = parseInt(headerMatch[2], 10);

    // Track line numbers and collect lines within the context window
    let currentLine = newStartLine;
    const relevantLines: { line: string; lineNum: number | null }[] = [];
    const minLine = targetLine - contextLines;
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

    if (relevantLines.length === 0) return diffHunk;

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
        return cleaned.length > 60 ? cleaned.substring(0, 57) + "..." : cleaned;
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
    return body
        .replace(/!\[(high|medium|low)\]\([^)]*\)/gi, "")
        .trim();
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
                author: firstComment.author,
                title: extractTitle(firstComment.body),
                issue: extractIssue(firstComment.body),
                diffHunk: trimDiffHunk(firstComment.diffHunk, thread.line),
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
