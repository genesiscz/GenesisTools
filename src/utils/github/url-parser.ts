// GitHub URL parsing utilities

import type { GitHubFileUrl, GitHubUrl } from "@app/github/types";

/**
 * Parse a GitHub URL into its components
 *
 * Supported formats:
 * - https://github.com/owner/repo/issues/123
 * - https://github.com/owner/repo/pull/456
 * - https://github.com/owner/repo/issues/123#issuecomment-789
 * - owner/repo#123
 * - #123 (requires repo context)
 */
export function parseGitHubUrl(input: string, defaultRepo?: string): GitHubUrl | null {
    // Full URL format
    const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:#issuecomment-(\d+))?/);

    if (urlMatch) {
        const [, owner, repo, typeStr, number, commentId] = urlMatch;
        return {
            owner,
            repo,
            type: typeStr === "pull" ? "pr" : commentId ? "comment" : "issue",
            number: parseInt(number, 10),
            commentId: commentId ? parseInt(commentId, 10) : undefined,
        };
    }

    // Short format: owner/repo#123
    const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (shortMatch) {
        const [, owner, repo, number] = shortMatch;
        return {
            owner,
            repo,
            type: "issue", // Will be determined when fetching
            number: parseInt(number, 10),
        };
    }

    // Issue number only: #123 or 123
    const numberMatch = input.match(/^#?(\d+)$/);
    if (numberMatch && defaultRepo) {
        const [owner, repo] = defaultRepo.split("/");
        if (owner && repo) {
            return {
                owner,
                repo,
                type: "issue",
                number: parseInt(numberMatch[1], 10),
            };
        }
    }

    return null;
}

/**
 * Extract comment ID from URL or string
 */
export function extractCommentId(input: string): number | null {
    // URL format
    const urlMatch = input.match(/#issuecomment-(\d+)/);
    if (urlMatch) {
        return parseInt(urlMatch[1], 10);
    }

    // Direct ID
    const idMatch = input.match(/^(\d+)$/);
    if (idMatch) {
        return parseInt(idMatch[1], 10);
    }

    return null;
}

/**
 * Parse date input (ISO 8601 or relative like "2d", "1w")
 */
export function parseDate(input: string): Date | null {
    // Relative format: Nd, Nw, Nm
    const relativeMatch = input.match(/^(\d+)([dwm])$/);
    if (relativeMatch) {
        const [, amount, unit] = relativeMatch;
        const now = new Date();
        const value = parseInt(amount, 10);

        switch (unit) {
            case "d":
                now.setDate(now.getDate() - value);
                return now;
            case "w":
                now.setDate(now.getDate() - value * 7);
                return now;
            case "m":
                now.setMonth(now.getMonth() - value);
                return now;
        }
    }

    // ISO 8601 format
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
        return date;
    }

    return null;
}

/**
 * Build GitHub URL from components
 */
export function buildGitHubUrl(
    owner: string,
    repo: string,
    type: "issue" | "pr",
    number: number,
    commentId?: number
): string {
    const typePath = type === "pr" ? "pull" : "issues";
    let url = `https://github.com/${owner}/${repo}/${typePath}/${number}`;
    if (commentId) {
        url += `#issuecomment-${commentId}`;
    }
    return url;
}

/**
 * Parse repo string (owner/repo)
 */
export function parseRepo(input: string): { owner: string; repo: string } | null {
    const match = input.match(/^([^/]+)\/([^/]+)$/);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
        };
    }
    return null;
}

/**
 * Detect repo from current git directory
 */
export async function detectRepoFromGit(): Promise<string | null> {
    try {
        const proc = Bun.spawn({
            cmd: ["git", "remote", "get-url", "origin"],
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            return null;
        }

        // Parse git remote URL
        const url = stdout.trim();

        // SSH format: git@github.com:owner/repo.git
        const sshMatch = url.match(/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?/);
        if (sshMatch) {
            return `${sshMatch[1]}/${sshMatch[2]}`;
        }

        // HTTPS format: https://github.com/owner/repo.git
        const httpsMatch = url.match(/github\.com\/([^/]+)\/([^.]+)(?:\.git)?/);
        if (httpsMatch) {
            return `${httpsMatch[1]}/${httpsMatch[2]}`;
        }
    } catch {
        // Ignore errors
    }

    return null;
}

/**
 * Parse a GitHub file URL into its components
 *
 * Supported formats:
 * - https://github.com/owner/repo/blob/ref/path/to/file
 * - https://github.com/owner/repo/blame/ref/path/to/file
 * - https://raw.githubusercontent.com/owner/repo/ref/path/to/file
 * - https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path
 * - https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path
 * - All above with optional #L10 or #L10-L20 line references
 */
export function parseGitHubFileUrl(input: string): GitHubFileUrl | null {
    // Extract line numbers if present (e.g., #L10 or #L10-L20)
    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    const lineMatch = input.match(/#L(\d+)(?:-L(\d+))?$/);
    if (lineMatch) {
        lineStart = parseInt(lineMatch[1], 10);
        lineEnd = lineMatch[2] ? parseInt(lineMatch[2], 10) : undefined;
        input = input.replace(/#L\d+(?:-L\d+)?$/, "");
    }

    // Pattern 1: github.com blob/blame URLs
    // https://github.com/owner/repo/blob/ref/path/to/file
    // https://github.com/owner/repo/blame/ref/path/to/file
    const githubMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob|blame)\/([^/]+)\/(.+)/);
    if (githubMatch) {
        return {
            owner: githubMatch[1],
            repo: githubMatch[2],
            ref: githubMatch[3],
            path: githubMatch[4],
            lineStart,
            lineEnd,
        };
    }

    // Pattern 2: raw.githubusercontent.com with refs/heads or refs/tags
    // https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path
    // https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path
    const rawRefsMatch = input.match(
        /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/refs\/(heads|tags)\/([^/]+)\/(.+)/
    );
    if (rawRefsMatch) {
        return {
            owner: rawRefsMatch[1],
            repo: rawRefsMatch[2],
            ref: rawRefsMatch[4], // branch or tag name
            path: rawRefsMatch[5],
            lineStart,
            lineEnd,
        };
    }

    // Pattern 3: raw.githubusercontent.com simple format
    // https://raw.githubusercontent.com/owner/repo/ref/path/to/file
    const rawSimpleMatch = input.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/);
    if (rawSimpleMatch) {
        return {
            owner: rawSimpleMatch[1],
            repo: rawSimpleMatch[2],
            ref: rawSimpleMatch[3],
            path: rawSimpleMatch[4],
            lineStart,
            lineEnd,
        };
    }

    return null;
}

/**
 * Build a GitHub commit URL.
 * Without prNumber: https://github.com/owner/repo/commit/SHA
 * With prNumber: https://github.com/owner/repo/pull/N/commits/SHA
 */
export function buildGitHubCommitUrl(
    owner: string,
    repo: string,
    sha: string,
    prNumber?: number
): string {
    if (prNumber) {
        return `https://github.com/${owner}/${repo}/pull/${prNumber}/commits/${sha}`;
    }
    return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

/**
 * Build raw.githubusercontent.com URL from components
 */
export function buildRawGitHubUrl(owner: string, repo: string, ref: string, path: string): string {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}
