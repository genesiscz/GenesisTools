import { SafeJSON } from "@genesiscz/utils/json";
import { decodeJwt } from "@genesiscz/utils/jwt";
import { logger } from "@genesiscz/utils/logger";
import { generatePkcePair } from "../oauth/pkce";
import { describeTokenError } from "./refresh";

/**
 * xAI's OIDC provider, driven the way the Grok CLI drives it.
 *
 * Verified 2026-09-09 against `https://auth.x.ai/.well-known/openid-configuration` and the
 * strings of grok 1.0.5: authorization code with PKCE S256, a public client (the token
 * endpoint accepts `none`), refresh grants, and a device-code grant this flow does not
 * use. The client id and the loopback redirect are the CLI's own registrations, so neither
 * is ours to choose; the scope is what the CLI's own token carries, `grok-cli:access` being
 * what the chat proxy checks.
 */
export const GROK_OIDC_ISSUER = "https://auth.x.ai";
export const GROK_OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_REDIRECT_URI = "http://127.0.0.1:2419/callback";
export const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const AUTH_URL = `${GROK_OIDC_ISSUER}/oauth2/authorize`;
const TOKEN_URL = `${GROK_OIDC_ISSUER}/oauth2/token`;

/** One token-endpoint round trip; the refresh runs inside the AI config lock, so it must not hang. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface GrokTokens {
    accessToken: string;
    refreshToken?: string;
    /** Unix ms. */
    expiresAt: number;
    idToken?: string;
}

interface TokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
}

function claimsOf(token: string): Record<string, unknown> {
    const result = decodeJwt(token);

    return result.ok ? (result.payload as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The token's own `exp` when it has one; the issuer's `expires_in` otherwise. */
function expiryOf(accessToken: string, expiresIn: unknown): number {
    const exp = claimsOf(accessToken).exp;

    if (typeof exp === "number") {
        return exp * 1000;
    }

    return Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000;
}

async function tokenRequest(body: Record<string, string>, what: string): Promise<GrokTokens> {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ ...body, client_id: GROK_OIDC_CLIENT_ID }).toString(),
    });

    if (!response.ok) {
        // The body may quote the submitted token back; `describeTokenError` redacts it.
        throw new Error(`Grok ${what} failed: ${response.status} ${describeTokenError(await response.text())}`);
    }

    const payload = SafeJSON.parse(await response.text(), { strict: true }) as TokenResponse;
    const accessToken = text(payload.access_token);

    if (!accessToken) {
        throw new Error(`Grok ${what} returned no access_token`);
    }

    const refreshToken = text(payload.refresh_token);
    const idToken = text(payload.id_token);

    return {
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        expiresAt: expiryOf(accessToken, payload.expires_in),
        ...(idToken === undefined ? {} : { idToken }),
    };
}

/** Browser PKCE login and refresh for a SuperGrok subscription, the shape `CodexOAuthClient` has. */
export class GrokOAuthClient {
    private pendingSession: { verifier: string; state: string } | null = null;

    /** The URL to open in the browser. Its `state` is what the loopback listener checks. */
    async startLogin(): Promise<string> {
        const { verifier, challenge, state } = await generatePkcePair({ verifierBytes: 43 });

        this.pendingSession = { verifier, state };

        const params = new URLSearchParams({
            client_id: GROK_OIDC_CLIENT_ID,
            response_type: "code",
            redirect_uri: GROK_REDIRECT_URI,
            scope: GROK_SCOPE,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
        });

        return `${AUTH_URL}?${params.toString()}`;
    }

    async exchangeCode(code: string): Promise<GrokTokens> {
        if (!this.pendingSession) {
            throw new Error("No pending OAuth session. Call startLogin() first.");
        }

        const { verifier } = this.pendingSession;
        this.pendingSession = null;

        return tokenRequest(
            {
                grant_type: "authorization_code",
                code,
                redirect_uri: GROK_REDIRECT_URI,
                code_verifier: verifier,
            },
            "token exchange"
        );
    }

    /**
     * The refresh grant for a grant WE store. A rotated refresh token replaces the old one;
     * an issuer that keeps the old one valid answers without a new one, so the old one stays.
     */
    async refresh(refreshToken: string): Promise<GrokTokens> {
        logger.info("[grok-oauth] refreshing the stored access token");

        const tokens = await tokenRequest(
            { grant_type: "refresh_token", refresh_token: refreshToken },
            "token refresh"
        );

        return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
    }
}

export const grokOAuth = new GrokOAuthClient();

/** What the tokens say about their owner. Decode only, never a network call. */
export interface GrokTokenIdentity {
    /** The xAI user id: `sub` of the id token, or of the access token. */
    userId?: string;
    email?: string;
    /** `team_id` of the access token, the same claim `GrokJwtClaims` reads. */
    teamId?: string;
    tier?: number;
}

export function identityFromGrokTokens(tokens: Pick<GrokTokens, "accessToken" | "idToken">): GrokTokenIdentity {
    const access = claimsOf(tokens.accessToken);
    const id = tokens.idToken === undefined ? {} : claimsOf(tokens.idToken);
    const userId = text(id.sub) ?? text(access.sub);
    const email = text(id.email) ?? text(access.email);
    const teamId = text(access.team_id);

    return {
        ...(userId === undefined ? {} : { userId }),
        ...(email === undefined ? {} : { email }),
        ...(teamId === undefined ? {} : { teamId }),
        ...(typeof access.tier === "number" ? { tier: access.tier } : {}),
    };
}
