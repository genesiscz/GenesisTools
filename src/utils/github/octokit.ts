// Octokit client setup with authentication

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { Octokit } from "octokit";

let _octokit: Octokit | null = null;

export type OctokitAuthMode = "default" | "prefer-gh-cli";

/**
 * Get or create authenticated Octokit instance (env token preferred — good for read).
 */
export function getOctokit(): Octokit {
    if (_octokit) {
        return _octokit;
    }

    const token = getGitHubToken("default");

    _octokit = new Octokit({
        auth: token,
    });

    return _octokit;
}

let _octokitWrite: Octokit | null = null;

/**
 * Octokit for write operations (merge, retarget, delete ref).
 *
 * Prefers `gh auth token` classic OAuth (`repo` scope) over fine-grained
 * GITHUB_TOKEN env PATs that often lack contents/PRs write on private repos.
 * Separate cache from getOctokit() so reads keep using env token when set.
 */
export function getOctokitForWrite(): Octokit {
    if (_octokitWrite) {
        return _octokitWrite;
    }

    const token = getGitHubToken("prefer-gh-cli");

    _octokitWrite = new Octokit({
        auth: token,
    });

    return _octokitWrite;
}

/**
 * Get GitHub token from environment or gh CLI.
 *
 * @param mode default — env first (read-friendly). prefer-gh-cli — gh OAuth first (write-friendly).
 */
function getGitHubToken(mode: OctokitAuthMode = "default"): string | undefined {
    const tryEnv = (): string | undefined => {
        const token = env.github.getToken();
        if (token) {
            const tokenEnvKey = env.github.getTokenEnvKey();
            logger.debug(`Using ${tokenEnvKey ?? "GITHUB_TOKEN"} from environment`);
            return token;
        }
        return undefined;
    };

    const tryGhCli = (): string | undefined => {
        const ghToken = getGhCliToken();
        if (ghToken) {
            logger.debug("Using token from gh auth token");
            return ghToken;
        }
        return undefined;
    };

    const tryGhConfig = (): string | undefined => {
        const ghConfigPath =
            process.platform === "win32"
                ? join(env.paths.getAppData() || join(homedir(), "AppData", "Roaming"), "gh", "hosts.yml")
                : join(homedir(), ".config", "gh", "hosts.yml");
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
        return undefined;
    };

    if (mode === "prefer-gh-cli") {
        const token = tryGhCli() ?? tryGhConfig() ?? tryEnv();
        if (token) {
            return token;
        }
    } else {
        const token = tryEnv() ?? tryGhCli() ?? tryGhConfig();
        if (token) {
            return token;
        }
    }

    // Return undefined (will work for public repos only)
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
