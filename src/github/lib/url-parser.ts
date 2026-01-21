// GitHub URL parsing utilities

import type { GitHubUrl } from '../types';

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
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:#issuecomment-(\d+))?/
  );

  if (urlMatch) {
    const [, owner, repo, typeStr, number, commentId] = urlMatch;
    return {
      owner,
      repo,
      type: typeStr === 'pull' ? 'pr' : commentId ? 'comment' : 'issue',
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
      type: 'issue', // Will be determined when fetching
      number: parseInt(number, 10),
    };
  }

  // Issue number only: #123 or 123
  const numberMatch = input.match(/^#?(\d+)$/);
  if (numberMatch && defaultRepo) {
    const [owner, repo] = defaultRepo.split('/');
    if (owner && repo) {
      return {
        owner,
        repo,
        type: 'issue',
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
      case 'd':
        now.setDate(now.getDate() - value);
        return now;
      case 'w':
        now.setDate(now.getDate() - value * 7);
        return now;
      case 'm':
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
export function buildGitHubUrl(owner: string, repo: string, type: 'issue' | 'pr', number: number, commentId?: number): string {
  const typePath = type === 'pr' ? 'pull' : 'issues';
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
      cmd: ['git', 'remote', 'get-url', 'origin'],
      stdio: ['ignore', 'pipe', 'pipe'],
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
