import { ACCESS_SKEW_MS } from "./constants.ts";
import { mcpFetch } from "./fetch.ts";
import { withRefreshLock } from "./lock.ts";
import { secretPath } from "./paths.ts";
import { readAccessToken, readExpiresAt, readRefreshToken, readSecret, writeServerTokens } from "./secrets.ts";
import { writeAuthStatus } from "./status.ts";

export class DiagnosticRefreshError extends Error {
    constructor() {
        super("diagnostic path refused to refresh an MCP OAuth token");
        this.name = "DiagnosticRefreshError";
    }
}

export function isAccessExpired(expiresAt: number | undefined, now = Date.now()): boolean {
    return expiresAt !== undefined && expiresAt - ACCESS_SKEW_MS <= now;
}

/**
 * Read the stored access token. Never talks to the token endpoint.
 */
export async function peekAccessToken(server: string): Promise<{
    accessToken?: string;
    expiresAt?: number;
    expired: boolean;
    hasRefresh: boolean;
}> {
    const accessToken = await readAccessToken(server);
    const expiresAt = await readExpiresAt(server);
    const hasRefresh = Boolean(await readRefreshToken(server));

    return {
        accessToken,
        expiresAt,
        expired: isAccessExpired(expiresAt),
        hasRefresh,
    };
}

export async function accessTokenForRequest(
    server: string,
    opts: {
        tokenEndpoint: string;
        resource: string;
        allowRefresh: boolean;
    }
): Promise<string> {
    const peek = await peekAccessToken(server);

    if (peek.accessToken && !peek.expired) {
        return peek.accessToken;
    }

    if (!opts.allowRefresh) {
        throw new DiagnosticRefreshError();
    }

    return withRefreshLock(server, async () => {
        const again = await peekAccessToken(server);

        if (again.accessToken && !again.expired) {
            return again.accessToken;
        }

        const refreshToken = await readRefreshToken(server);

        if (!refreshToken) {
            throw new Error(`No refresh token for ${server}. Run tools mcp-manager auth login ${server}`);
        }

        const clientId = await readSecret(secretPath(server, "client-id"));
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            resource: opts.resource,
        });

        if (clientId) {
            body.set("client_id", clientId);
        }

        const response = await mcpFetch(opts.tokenEndpoint, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        });
        const json = (await response.json()) as Record<string, unknown>;

        if (!response.ok || typeof json.access_token !== "string") {
            const err = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;

            if (err === "invalid_grant") {
                await writeServerTokens(server, {
                    accessToken: again.accessToken ?? "",
                    expiresAt: again.expiresAt,
                });
            }

            await writeAuthStatus({
                server,
                resource: opts.resource,
                updatedAt: Date.now(),
                lastError: err,
                expiresAt: again.expiresAt,
            });
            throw new Error(`Refresh failed for ${server} (${err}). Run tools mcp-manager auth login ${server}`);
        }

        const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
        const expiresAt = Date.now() + expiresIn * 1000;
        const nextRefresh = typeof json.refresh_token === "string" ? json.refresh_token : refreshToken;

        await writeServerTokens(server, {
            accessToken: json.access_token,
            refreshToken: nextRefresh,
            expiresAt,
            clientId: clientId,
        });
        await writeAuthStatus({
            server,
            resource: opts.resource,
            updatedAt: Date.now(),
            expiresAt,
            clientId,
        });

        return json.access_token;
    });
}
