import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { ACCESS_SKEW_MS } from "./constants.ts";
import { mcpFetchChecked, readJsonRecord } from "./fetch.ts";
import { withRefreshLock } from "./lock.ts";
import { secretPath } from "./paths.ts";
import { safeTokenErrorCode } from "./redact.ts";
import { deleteSecret, readServerTokenSnapshot, writeServerTokensUnlocked } from "./secrets.ts";
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
    const snapshot = await readServerTokenSnapshot(server);

    return {
        accessToken: snapshot.accessToken,
        expiresAt: snapshot.expiresAt,
        expired: isAccessExpired(snapshot.expiresAt),
        hasRefresh: snapshot.hasRefresh,
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
        const current = await readServerTokenSnapshot(server, { includeRefreshToken: true, includeClient: true });

        if (current.accessToken && !isAccessExpired(current.expiresAt)) {
            return current.accessToken;
        }

        const refreshToken = current.refreshToken;

        if (!refreshToken) {
            throw new Error(`No refresh token for ${server}. Run ${toolCommand("mcp-manager auth login", server)}`);
        }

        const clientId = current.clientId;
        const clientSecret = current.clientSecret;
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            resource: opts.resource,
        });

        if (clientId) {
            body.set("client_id", clientId);
        }

        if (clientSecret) {
            body.set("client_secret", clientSecret);
        }

        const response = await mcpFetchChecked(opts.tokenEndpoint, opts.resource, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        });
        const { json } = await readJsonRecord(response);
        const accessToken = json?.access_token;

        if (!response.ok || typeof accessToken !== "string") {
            // `text.slice(0, 80)` used to land here, which put an arbitrary 80 bytes of a
            // provider response into auth-status.json AND onto the terminal.
            const err = safeTokenErrorCode(json?.error, response.status);
            // Bounded values only. `error` and `error_description` are both
            // provider-controlled free text, and this refresh runs unattended inside the
            // gateway, so the day-stamped log file is the durable artifact nobody is
            // watching. The rule this file follows: provider free text may be shown ONCE
            // to the person who triggered the action, and is never written to storage.
            logger.warn({ server, status: response.status, code: err }, "mcp token refresh was refused");

            if (err === "invalid_grant") {
                await deleteSecret(secretPath(server, "refresh-token"));
                await deleteSecret(secretPath(server, "access-token"));
                await deleteSecret(secretPath(server, "token-expires-at"));
            }

            await writeAuthStatus({
                server,
                resource: opts.resource,
                updatedAt: Date.now(),
                lastError: err,
                expiresAt: current.expiresAt,
            });
            throw new Error(
                `Refresh failed for ${server} (${err}). Run ${toolCommand("mcp-manager auth login", server)}`
            );
        }

        const expiresIn = typeof json?.expires_in === "number" ? json.expires_in : 3600;
        const expiresAt = Date.now() + expiresIn * 1000;
        const nextRefresh = typeof json?.refresh_token === "string" ? json.refresh_token : refreshToken;

        await writeServerTokensUnlocked(server, {
            accessToken,
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

        return accessToken;
    });
}
