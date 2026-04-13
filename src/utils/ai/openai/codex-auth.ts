import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";

// OpenAI Codex OAuth constants (reverse-engineered from Codex CLI)
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const WHAM_BASE_URL = "https://chatgpt.com/backend-api/wham";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

/**
 * Shape of ~/.codex/auth.json as written by the official Codex CLI.
 * Two known formats:
 *   - Official CLI:  { auth_mode, tokens: { access_token, refresh_token, account_id }, last_refresh }
 *   - Third-party:   { type: "oauth", access, refresh, expires, accountId }
 */
interface CodexAuthJsonOfficial {
    auth_mode: string;
    tokens: {
        id_token?: string;
        access_token: string;
        refresh_token: string;
        account_id?: string;
    };
    last_refresh?: string;
}

interface CodexAuthJsonThirdParty {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
}

export interface CodexTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix timestamp in ms (0 if unknown — will trigger refresh)
    accountId?: string;
}

/** Default path for Codex CLI's auth cache */
export const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

/**
 * Read tokens from ~/.codex/auth.json (written by `codex login`).
 * Handles both the official Codex CLI format and third-party variants.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function readCodexAuthJson(path: string = CODEX_AUTH_PATH): Promise<CodexTokens | null> {
    try {
        const file = Bun.file(path);

        if (!(await file.exists())) {
            return null;
        }

        const raw = await file.json();

        // Official Codex CLI format: { auth_mode, tokens: { access_token, refresh_token } }
        if (raw.tokens?.access_token) {
            const data = raw as CodexAuthJsonOfficial;
            const accessToken = data.tokens.access_token;

            // Extract expiry from JWT (exp claim is in seconds)
            let expiresAt = 0;

            try {
                const payload = SafeJSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
                if (typeof payload.exp === "number") {
                    expiresAt = payload.exp * 1000;
                }
            } catch {
                // Can't parse JWT — expiresAt stays 0, which triggers refresh
            }

            return {
                accessToken,
                refreshToken: data.tokens.refresh_token,
                expiresAt,
                accountId: data.tokens.account_id,
            };
        }

        // Third-party format: { type: "oauth", access, refresh, expires }
        if (raw.access && raw.refresh) {
            const data = raw as CodexAuthJsonThirdParty;
            return {
                accessToken: data.access,
                refreshToken: data.refresh,
                expiresAt: data.expires ?? 0,
                accountId: data.accountId,
            };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extract account ID from an OpenAI JWT access token.
 * Uses a 3-level fallback (no signature verification needed):
 * 1. Top-level chatgpt_account_id
 * 2. https://api.openai.com/auth → chatgpt_account_id
 * 3. organizations[0].id
 */
export function extractAccountId(token: string): string | undefined {
    try {
        const payload = SafeJSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        const authClaim = payload["https://api.openai.com/auth"];

        return (
            payload.chatgpt_account_id ??
            authClaim?.chatgpt_account_id ??
            authClaim?.organizations?.[0]?.id ??
            undefined
        );
    } catch {
        return undefined;
    }
}

/**
 * Extract email from an OpenAI JWT token.
 */
export function extractEmail(token: string): string | undefined {
    try {
        const payload = SafeJSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        return payload.email ?? payload["https://api.openai.com/profile"]?.email ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extract plan type (e.g. "plus", "pro") from an OpenAI JWT token.
 */
export function extractPlanType(token: string): string | undefined {
    try {
        const payload = SafeJSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        return payload["https://api.openai.com/auth"]?.chatgpt_plan_type ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * OpenAI Codex OAuth client for browser-based PKCE login and token refresh.
 */
export class CodexOAuthClient {
    private pendingSession: { verifier: string; state: string } | null = null;

    /**
     * Generate PKCE authorization URL.
     * Returns the URL to open in the user's browser.
     */
    async startLogin(): Promise<string> {
        const verifier = this.generateRandomString(43);
        const challenge = await this.sha256Base64Url(verifier);
        const state = this.generateRandomString(32);

        this.pendingSession = { verifier, state };

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            scope: SCOPE,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            // OpenAI-specific params required by WHAM
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: "opencode",
        });

        return `${AUTH_URL}?${params.toString()}`;
    }

    /**
     * Exchange the authorization code for tokens.
     */
    async exchangeCode(code: string): Promise<CodexTokens> {
        if (!this.pendingSession) {
            throw new Error("No pending OAuth session. Call startLogin() first.");
        }

        const { verifier } = this.pendingSession;
        this.pendingSession = null;

        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: verifier,
            }),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Token exchange failed: ${res.status} ${text}`);
        }

        const data = await res.json();
        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
        const accessToken = data.access_token;

        return {
            accessToken,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + expiresIn * 1000,
            accountId: extractAccountId(data.id_token ?? accessToken),
        };
    }

    /**
     * Refresh tokens using a refresh token.
     */
    async refresh(refreshToken: string): Promise<CodexTokens> {
        logger.info("[codex-oauth] Refreshing access token...");

        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Token refresh failed: ${res.status} ${text}`);
        }

        const data = await res.json();
        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
        const accessToken = data.access_token;

        logger.info(`[codex-oauth] Token refreshed, expires in ${expiresIn}s`);

        return {
            accessToken,
            refreshToken: data.refresh_token ?? refreshToken,
            expiresAt: Date.now() + expiresIn * 1000,
            accountId: extractAccountId(accessToken),
        };
    }

    /**
     * Check if tokens need refresh (expired or expiring within buffer).
     */
    needsRefresh(expiresAt: number, bufferMs: number = 30_000): boolean {
        return Date.now() + bufferMs >= expiresAt;
    }

    private generateRandomString(length: number): string {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }

    private async sha256Base64Url(input: string): Promise<string> {
        const encoded = new TextEncoder().encode(input);
        const hash = await crypto.subtle.digest("SHA-256", encoded);
        return btoa(String.fromCharCode(...new Uint8Array(hash)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }
}

export const codexOAuth = new CodexOAuthClient();
