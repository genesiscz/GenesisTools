// Octokit client setup with authentication

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Octokit } from "octokit";

const httpProf = profiler.scope("forge-http");

/**
 * Every request of this client (REST and GraphQL) as one forge-http profiling line: method, URL, status
 * and time. The URL never carries the token, which travels in a header. Off unless the scope is on.
 */
function profiled(octokit: Octokit): Octokit {
    if (!httpProf.enabled) {
        return octokit;
    }

    octokit.hook.wrap("request", async (request, options) => {
        const { method, url } = octokit.request.endpoint.parse(options);
        const stop = httpProf.start(`${method} ${url}`);

        try {
            const response = await request(options);
            stop(String(response.status));
            return response;
        } catch (error) {
            const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
            stop(`failed${typeof status === "number" ? ` ${status}` : ""}`);
            throw error;
        }
    });

    return octokit;
}

/** A GraphQL answer that names a repository or object the token cannot see (sent with HTTP 200). */
function graphqlNotFound(data: unknown): boolean {
    if (typeof data !== "object" || data === null || !("errors" in data) || !Array.isArray(data.errors)) {
        return false;
    }

    return data.errors.some(
        (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            (("type" in error && (error.type === "NOT_FOUND" || error.type === "FORBIDDEN")) ||
                ("message" in error &&
                    typeof error.message === "string" &&
                    error.message.startsWith("Could not resolve to a")))
    );
}

/**
 * A GraphQL request's body carries its text as `query`. The first keyword of the document says nothing: a
 * write can follow a fragment (`fragment F on T {...} mutation M {...}`) or another operation chosen by
 * `operationName`. So a document is a read only when it names no `mutation` or `subscription` anywhere. One
 * that merely mentions the word in a string or a comment loses the fallback, which costs a retry and never
 * a write under the wider token.
 */
function isGraphqlQuery(options: { url?: string; query?: unknown }): boolean {
    return (
        options.url === "/graphql" &&
        typeof options.query === "string" &&
        !/\b(?:mutation|subscription)\b/i.test(options.query)
    );
}

/**
 * A read token from the environment is often a fine-grained PAT scoped to some owners: a repository of
 * another organization answers "Could not resolve to a Repository" (GraphQL) or 404/403 (REST), while
 * the `gh` login can see it (Reservine/ReservineBack, 2026-10-04). Such a request is sent once more with
 * the `gh` login's token. Read requests only, and only when that token differs from the env one.
 */
export function withGhFallback(
    octokit: Octokit,
    envToken: string,
    {
        ghToken = getGhCliToken,
        client = (token: string) => new Octokit({ auth: token }),
    }: {
        ghToken?: () => string | undefined;
        client?: (token: string) => Octokit;
    } = {}
): Octokit {
    // A client of its own: the auth hook inside this one would put the env token back on the retry.
    let fallback: Octokit | null | undefined;
    const fallbackClient = (): Octokit | null => {
        if (fallback === undefined) {
            const token = ghToken();
            fallback = token && token !== envToken ? client(token) : null;
        }

        return fallback;
    };

    octokit.hook.wrap("request", async (request, options) => {
        const retry = (reason: string) => {
            const client = fallbackClient();
            if (!client) {
                return null;
            }

            logger.debug(
                { url: options.url, reason },
                "github: the env token cannot see this; retrying with the gh login"
            );
            // Without this client's `request` options (they carry its hook and its auth) and the env
            // token's header: with them, the retry came back through this hook with the env token, failed
            // again and retried again (980 retries in one run, 2026-10-04).
            const { authorization: _envAuth, ...headers } = options.headers;
            const { request: _ownHook, ...rest } = options;
            return client.request({ ...rest, headers });
        };

        let response: Awaited<ReturnType<typeof request>>;

        try {
            response = await request(options);
        } catch (error) {
            const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
            const method = String(options.method ?? "GET").toUpperCase();
            if ((status === 404 || status === 403) && (method === "GET" || isGraphqlQuery(options))) {
                const again = retry(`http ${status}`);
                if (again) {
                    return await again;
                }
            }

            throw error;
        }

        // Outside the try above: a failure here is the FALLBACK's own, never a reason to retry again.
        if (isGraphqlQuery(options) && graphqlNotFound(response.data)) {
            return (await retry("graphql not found")) ?? response;
        }

        return response;
    });

    return octokit;
}

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
    const client = new Octokit({ auth: token });
    const envToken = env.github.getToken();

    _octokit = profiled(token && token === envToken ? withGhFallback(client, envToken) : client);

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

    _octokitWrite = profiled(
        new Octokit({
            auth: token,
        })
    );

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
