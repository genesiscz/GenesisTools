import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface OAuthProfileAccount {
    uuid: string;
    full_name: string;
    display_name: string;
    email: string;
    has_claude_max: boolean;
    has_claude_pro: boolean;
    created_at: string;
}

export interface OAuthProfileOrganization {
    uuid: string;
    name: string;
    organization_type: string;
    billing_type: string;
    rate_limit_tier: string;
    has_extra_usage_enabled: boolean;
    subscription_status: string;
    subscription_created_at: string;
}

export interface OAuthProfileResponse {
    account: OAuthProfileAccount;
    organization: OAuthProfileOrganization;
}

export interface ClaudeJsonAccount {
    accountUuid?: string;
    emailAddress?: string;
    displayName?: string;
    organizationUuid?: string;
    billingType?: string;
}

export interface AccountInfo {
    api?: OAuthProfileResponse;
    claudeJson?: ClaudeJsonAccount;
}

export interface KeychainCredentials {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // Unix timestamp in ms
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
    account: AccountInfo;
}

// Claude Code's official OAuth client ID
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Endpoints + scopes mirror Claude Code (verified against the 2.1.206 binary;
// migrated off claude.ai/console.anthropic.com in CC 2.1.6+).
const AUTH_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

// Full scopes in Claude Code's order (its WJo union for normal login)
const FULL_SCOPES =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

// Claude Code sends expires_in=31536000 (1 year) on its setup-token and
// login-from-refresh-token exchanges; we request the same on login.
const ONE_YEAR_SECONDS = 31536000;

export interface PKCEChallenge {
    verifier: string;
    challenge: string;
    state: string;
}

export interface OAuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix timestamp in ms
    scopes: string[];
    account?: { uuid: string; email: string };
    organization?: { uuid: string; name: string };
}

/**
 * Claude OAuth client for managing authentication flows.
 * Handles PKCE generation, authorization URL creation, token exchange, and refresh.
 */
export class ClaudeOAuthClient {
    private pendingSession: { verifier: string; state: string } | null = null;

    /**
     * Start a new OAuth login flow.
     * Opens the authorization URL and stores session for code exchange.
     */
    async startLogin(scopes: string = FULL_SCOPES): Promise<string> {
        const pkce = await this.generatePKCE();
        this.pendingSession = { verifier: pkce.verifier, state: pkce.state };

        const params = new URLSearchParams({
            code: "true",
            client_id: CLAUDE_CODE_CLIENT_ID,
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            scope: scopes,
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
            state: pkce.state,
        });

        return `${AUTH_URL}?${params.toString()}`;
    }

    /**
     * Exchange the authorization code for tokens.
     * Call this after the user authorizes and pastes the code.
     */
    async exchangeCode(codeInput: string): Promise<OAuthTokens> {
        if (!this.pendingSession) {
            throw new Error("No pending OAuth session. Call startLogin() first.");
        }

        const { verifier } = this.pendingSession;
        this.pendingSession = null; // Clear session after use

        // Claude returns "code#state" format
        const [code, state] = codeInput.includes("#") ? codeInput.split("#") : [codeInput, ""];

        const body: Record<string, unknown> = {
            grant_type: "authorization_code",
            client_id: CLAUDE_CODE_CLIENT_ID,
            code,
            state,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
            expires_in: ONE_YEAR_SECONDS,
        };

        let res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify(body),
        });

        if (!res.ok && res.status >= 400 && res.status < 500) {
            // Server may reject the 1-year expires_in for this grant type —
            // retry once without it rather than failing the whole login.
            const text = await res.text();
            logger.warn(
                `[oauth] exchange with expires_in failed (${res.status} ${text.slice(0, 200)}), retrying without`
            );
            delete body.expires_in;
            res = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(body),
            });
        }

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Token exchange failed: ${res.status} ${text}`);
        }

        const data = await res.json();
        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + expiresIn * 1000,
            scopes: (data.scope ?? "").split(" ").filter(Boolean),
            account: data.account ? { uuid: data.account.uuid, email: data.account.email_address } : undefined,
            organization: data.organization
                ? { uuid: data.organization.uuid, name: data.organization.name }
                : undefined,
        };
    }

    /**
     * Refresh tokens using a refresh token.
     * WARNING: This invalidates the old refresh token.
     */
    async refresh(refreshToken: string): Promise<OAuthTokens> {
        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: CLAUDE_CODE_CLIENT_ID,
            }),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Token refresh failed: ${res.status} ${text}`);
        }

        const data = await res.json();
        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + expiresIn * 1000,
            scopes: (data.scope ?? "").split(" ").filter(Boolean),
        };
    }

    /**
     * Check if tokens need refresh (expired or expiring within buffer).
     */
    needsRefresh(expiresAt: number, bufferMs: number = 5 * 60 * 1000): boolean {
        return Date.now() + bufferMs >= expiresAt;
    }

    private async generatePKCE(): Promise<PKCEChallenge> {
        const verifierBytes = new Uint8Array(32);
        crypto.getRandomValues(verifierBytes);
        const verifier = this.base64UrlEncode(verifierBytes);

        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
        const challenge = this.base64UrlEncode(new Uint8Array(hashBuffer));

        const stateBytes = new Uint8Array(32);
        crypto.getRandomValues(stateBytes);
        const state = this.base64UrlEncode(stateBytes);

        return { verifier, challenge, state };
    }

    private base64UrlEncode(bytes: Uint8Array): string {
        const base64 = btoa(String.fromCharCode(...bytes));
        return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
}

// Singleton instance for convenience
export const claudeOAuth = new ClaudeOAuthClient();

// Legacy function exports for backwards compatibility
export async function startOAuthLogin(scopes: string = FULL_SCOPES) {
    const authUrl = await claudeOAuth.startLogin(scopes);
    return { authUrl, verifier: "", state: "" }; // verifier/state managed internally now
}

export async function exchangeOAuthCode(codeInput: string, _verifier?: string) {
    return claudeOAuth.exchangeCode(codeInput);
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfileResponse | undefined> {
    try {
        const res = await fetch(PROFILE_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                Accept: "application/json",
            },
        });
        if (!res.ok) {
            return undefined;
        }
        return (await res.json()) as OAuthProfileResponse;
    } catch {
        return undefined;
    }
}

export async function getClaudeJsonAccount(): Promise<ClaudeJsonAccount | undefined> {
    try {
        const file = Bun.file(join(homedir(), ".claude.json"));
        const data = await file.json();
        const acct = data?.oauthAccount;
        if (!acct) {
            return undefined;
        }
        return {
            accountUuid: acct.accountUuid,
            emailAddress: acct.emailAddress,
            displayName: acct.displayName,
            organizationUuid: acct.organizationUuid,
            billingType: acct.billingType,
        };
    } catch {
        return undefined;
    }
}

export async function getKeychainCredentials(): Promise<KeychainCredentials | null> {
    try {
        const proc = Bun.spawn({
            cmd: ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            stdout: "pipe",
            stderr: "pipe",
        });
        const text = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0 || !text.trim()) {
            return null;
        }

        const data = SafeJSON.parse(text.trim(), { strict: true });
        const oauth = data.claudeAiOauth;
        if (!oauth?.accessToken) {
            return null;
        }

        const [api, claudeJson] = await Promise.all([fetchOAuthProfile(oauth.accessToken), getClaudeJsonAccount()]);

        return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
            scopes: oauth.scopes,
            subscriptionType: oauth.subscriptionType,
            rateLimitTier: oauth.rateLimitTier,
            account: { api, claudeJson },
        };
    } catch {
        return null;
    }
}
