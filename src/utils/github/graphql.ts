// GraphQL helpers for GitHub API

import { getOctokit } from "@app/utils/github/octokit";

interface CommentReactionInfo {
    issueNumber: number;
    maxCommentReactions: number;
    totalCommentReactions: number;
}

/**
 * Batch-fetch comment reaction counts for multiple issues in a single repo.
 * Uses GraphQL aliases to fetch up to 50 issues per request.
 * Returns max comment reaction count per issue for filtering.
 */
export async function batchFetchCommentReactions(
    owner: string,
    repo: string,
    issueNumbers: number[]
): Promise<Map<number, CommentReactionInfo>> {
    const octokit = getOctokit();
    const results = new Map<number, CommentReactionInfo>();

    const BATCH_SIZE = 50;
    for (let i = 0; i < issueNumbers.length; i += BATCH_SIZE) {
        const batch = issueNumbers.slice(i, i + BATCH_SIZE);
        const aliases = batch
            .map(
                (num) =>
                    `i${num}: issueOrPullRequest(number: ${num}) { ... on Issue { number comments(first: 100) { nodes { reactions { totalCount } } } } ... on PullRequest { number comments(first: 100) { nodes { reactions { totalCount } } } } }`
            )
            .join("\n");

        const query = `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${aliases}
      }
    }`;

        const data = await octokit.graphql<Record<string, Record<string, unknown>>>(query, { owner, repo });
        const repoData = data.repository as Record<
            string,
            { number?: number; comments?: { nodes: { reactions?: { totalCount: number } }[] } }
        >;

        for (const num of batch) {
            const item = repoData[`i${num}`];
            if (!item?.comments?.nodes) continue;

            let maxReactions = 0;
            let totalReactions = 0;
            for (const comment of item.comments.nodes) {
                const count = comment.reactions?.totalCount || 0;
                totalReactions += count;
                if (count > maxReactions) maxReactions = count;
            }

            results.set(num, {
                issueNumber: num,
                maxCommentReactions: maxReactions,
                totalCommentReactions: totalReactions,
            });
        }
    }

    return results;
}
