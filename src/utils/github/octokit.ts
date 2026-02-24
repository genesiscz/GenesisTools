// Octokit client setup with authentication

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { Octokit } from "octokit";

let _octokit: Octokit | null = null;

/**
 * Get or create authenticated Octokit instance
 */
export function getOctokit(): Octokit {
    if (_octokit) {
        return _octokit;
    }

    const token = getGitHubToken();

    _octokit = new Octokit({
        auth: token,
    });

    return _octokit;
}

/**
 * Get GitHub token from environment or gh CLI
 */
function getGitHubToken(): string | undefined {
    // 1. Check environment variables
    if (process.env.GITHUB_TOKEN) {
        logger.debug("Using GITHUB_TOKEN from environment");
        return process.env.GITHUB_TOKEN;
    }

    if (process.env.GH_TOKEN) {
        logger.debug("Using GH_TOKEN from environment");
        return process.env.GH_TOKEN;
    }

    if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
        logger.debug("Using GITHUB_PERSONAL_ACCESS_TOKEN from environment");
        return process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }

    // 2. Try `gh auth token` command (works with modern gh CLI)
    const ghToken = getGhCliToken();
    if (ghToken) {
        logger.debug("Using token from gh auth token");
        return ghToken;
    }

    // 3. Fallback: Try to read from gh CLI config (older versions)
    const ghConfigPath = join(homedir(), ".config", "gh", "hosts.yml");
    if (existsSync(ghConfigPath)) {
        try {
            const configContent = readFileSync(ghConfigPath, "utf-8");
            // Simple YAML parsing for oauth_token
            const match = configContent.match(/oauth_token:\s*(.+)/);
            if (match) {
                logger.debug("Using token from gh CLI config");
                return match[1].trim();
            }
        } catch (err) {
            logger.debug({ err }, "Failed to read gh CLI config");
        }
    }

    // 4. Return undefined (will work for public repos only)
    logger.warn("No GitHub token found. Will have limited API access.");
    return undefined;
}

/**
 * Get the token from the gh CLI (classic OAuth token).
 * This token typically has the classic `repo` scope, allowing repository
 * mutations (including pull request updates) that some fine-grained PATs
 * may not be authorized to perform.
 */
export function getGhCliToken(): string | undefined {
    try {
        const result = Bun.spawnSync(["gh", "auth", "token"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        if (result.exitCode === 0) {
            const token = result.stdout.toString().trim();
            if (token) {
                return token;
            }
        }
    } catch (err) {
        logger.debug({ err }, "Failed to run gh auth token");
    }
    return undefined;
}

/**
 * Check if we have valid authentication
 */
export async function checkAuth(): Promise<{ authenticated: boolean; user?: string; scopes?: string[] }> {
    const octokit = getOctokit();

    try {
        const { data, headers } = await octokit.rest.users.getAuthenticated();
        const scopes = (headers["x-oauth-scopes"] as string)?.split(", ") || [];
        return {
            authenticated: true,
            user: data.login,
            scopes,
        };
    } catch {
        return {
            authenticated: false,
        };
    }
}

/**
 * Get rate limit status
 */
export async function getRateLimit(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
    used: number;
}> {
    const octokit = getOctokit();
    const { data } = await octokit.rest.rateLimit.get();

    return {
        limit: data.rate.limit,
        remaining: data.rate.remaining,
        reset: new Date(data.rate.reset * 1000),
        used: data.rate.used,
    };
}
