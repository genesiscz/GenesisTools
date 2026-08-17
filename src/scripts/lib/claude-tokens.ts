/**
 * Credentials for remote MCP servers.
 *
 * mcporter can run its own OAuth dance, but a script is headless: there is no
 * browser to bounce through. Claude Code has already done that dance and stored
 * the result (keychain payload key `mcpOAuth`), so we read its store and hand
 * mcporter a Bearer header instead.
 *
 * Without this a remote server fails in a way that reads like a transport bug:
 * the streamable POST 401s, mcporter falls back to the legacy SSE transport,
 * and the GET returns 405. The error you see is "SSE error: Non-200 status code
 * (405)", which says nothing about the missing token.
 *
 * Refresh is deliberately NOT performed here. OAuth refresh tokens rotate:
 * spending Claude Code's stored one would invalidate the copy Claude Code still
 * holds and break the server inside the app. An expired token is reported and
 * the caller re-authorises through the normal client (`/mcp`).
 *
 * Reusing the app's token also dodges per-client whitelisting: some vendors
 * (Figma) answer dynamic client registration from unapproved clients with 403.
 * Borrowing a token an approved client obtained sidesteps registration, which
 * is why these scripts connect at all. Do not "do it properly" by registering
 * a new OAuth client — that is the path that fails.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeychainPayload } from "@genesiscz/utils/claude/keychain";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface McpToken {
    serverName: string;
    serverUrl: string;
    accessToken: string;
    expiresAt?: number;
    /** Present but unused: see the rotation note above. */
    refreshToken?: string;
}

/** Milliseconds before expiry at which we still call a token stale. */
const SKEW_MS = 60_000;

async function readCredentialsFile(): Promise<Record<string, unknown> | undefined> {
    try {
        const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf-8");
        return SafeJSON.parse(raw, { strict: true }) as Record<string, unknown>;
    } catch (error) {
        logger.debug({ error }, "no ~/.claude/.credentials.json fallback");
        return undefined;
    }
}

/**
 * Entries with an empty accessToken are dropped: a plugin-scoped server that
 * was never authorised leaves a shell of an entry behind, and treating that as
 * a credential produces a 401 rather than the clearer "no token" path.
 *
 * Exported for tests; production code goes through `loadClaudeTokens`.
 */
export function parseTokens(payload: Record<string, unknown>): McpToken[] {
    const rawStore = payload.mcpOAuth;

    if (!rawStore || typeof rawStore !== "object" || Array.isArray(rawStore)) {
        return [];
    }

    const tokens: McpToken[] = [];

    for (const rawEntry of Object.values(rawStore as Record<string, unknown>)) {
        // A null or non-object entry in an otherwise valid payload must not
        // throw and take every remote server down with it.
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
            continue;
        }

        const entry = rawEntry as Record<string, unknown>;
        const accessToken = entry.accessToken;
        const serverUrl = entry.serverUrl;

        if (typeof accessToken !== "string" || accessToken === "" || typeof serverUrl !== "string") {
            continue;
        }

        tokens.push({
            serverName: typeof entry.serverName === "string" ? entry.serverName : "?",
            serverUrl,
            accessToken,
            expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : undefined,
            refreshToken: typeof entry.refreshToken === "string" ? entry.refreshToken : undefined,
        });
    }

    return tokens;
}

let cached: McpToken[] | undefined;

/** Every usable MCP OAuth token Claude Code holds. */
export async function loadClaudeTokens(options: { refresh?: boolean } = {}): Promise<McpToken[]> {
    if (cached && !options.refresh) {
        return cached;
    }

    let payload: Record<string, unknown> | undefined;

    if (process.platform === "darwin") {
        payload = (await readKeychainPayload()) ?? undefined;
    }

    payload ??= await readCredentialsFile();
    cached = payload ? parseTokens(payload) : [];
    logger.debug({ tokens: cached.map((t) => t.serverName) }, "claude mcp tokens loaded");
    return cached;
}

function sameEndpoint(a: string, b: string): boolean {
    try {
        const ua = new URL(a);
        const ub = new URL(b);

        return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "");
    } catch (error) {
        logger.debug({ a, b, error }, "endpoint compare fell back to string equality");
        return a === b;
    }
}

export function isExpired(token: McpToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - SKEW_MS <= Date.now();
}

/** The token whose serverUrl addresses the same endpoint, ignoring trailing slashes. */
export function matchToken(tokens: McpToken[], url: string): McpToken | undefined {
    return tokens.find((t) => sameEndpoint(t.serverUrl, url));
}

export interface AuthLookup {
    headers?: Record<string, string>;
    /** Set when a token exists but cannot be used. */
    problem?: string;
    /** Set when no token was found at all. The connection is still attempted. */
    missing?: string;
}

/**
 * Bearer header for a remote server, when Claude Code holds a live token.
 *
 * A missing token is not an error: plenty of remote servers are open, and the
 * caller should attempt the connection either way. It is still reported,
 * because a closed server without a token fails as an opaque SSE 405 that
 * names neither the server nor the credential.
 */
export async function authFor(url: string, options: { refresh?: boolean } = {}): Promise<AuthLookup> {
    const tokens = await loadClaudeTokens(options);
    const token = matchToken(tokens, url);

    if (!token) {
        return {
            missing:
                `no stored OAuth token for ${url}. If the server is open this is fine; if it is not, ` +
                'the connection will fail as "SSE error: Non-200 status code (405)". ' +
                (tokens.length === 0
                    ? "Claude Code holds no MCP tokens at all — authorise the server with /mcp first."
                    : `Claude Code holds tokens for: ${tokens.map((t) => t.serverName).join(", ")}.`),
        };
    }

    if (isExpired(token)) {
        return {
            problem:
                `token for ${token.serverName} expired ${new Date(token.expiresAt ?? 0).toISOString()}. ` +
                "Re-authorise in Claude Code with /mcp, then re-run.",
        };
    }

    return { headers: { Authorization: `Bearer ${token.accessToken}` } };
}
