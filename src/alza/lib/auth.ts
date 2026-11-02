import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { ImpersonatedHttpClient } from "@genesiscz/utils/http/impersonate/client";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { z } from "zod";
import {
    discoverySchema,
    type PendingLogin,
    pendingLoginSchema,
    type StoredTokens,
    storedTokensSchema,
    tokenResponseSchema,
} from "./account-schemas";
import { APP_USER_AGENT } from "./api";
import type { Storefront } from "./storefront";

/**
 * Alza account sign-in: OAuth 2.0 Authorization Code + PKCE against identity.alza.cz with the Android app's client.
 * Adapted from lukabudik/alza-mcp-community (MIT) — scripts/alza-auth-login.mjs and src/infra/mobile-api.ts.
 *
 * The user signs in in a browser; this tool never sees a password. The browser then tries to open
 * `alza://identity?code=…&state=…`, which a desktop browser cannot open, and the user pastes that URL back. The PKCE
 * verifier waits in a pending file between the two steps, so `--print-url` and `--redirect-url` can be two processes.
 */

const AUTHORITY = "https://identity.alza.cz";
const CLIENT_ID = "alza_Android";
export const REDIRECT_URI = "alza://identity";
/**
 * The `alza_Android` client is confidential: the token endpoint refuses a request without the secret embedded in the
 * Android app (HTTP 400 invalid_client). Decoded from the APK by alza-mcp-community (scripts/alza-client-secret.mjs).
 */
const CLIENT_SECRET = "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
const SCOPE = "email openid profile alza offline_access";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** A pending sign-in older than this is refused: the authorization code it waits for is long dead. */
const PENDING_MAX_AGE_MS = 30 * 60_000;

export const SIGN_IN_HINT = `Sign in first: ${toolCommand("alza auth login")}`;

export class NotSignedInError extends Error {
    constructor(message = SIGN_IN_HINT) {
        super(message);
        this.name = "NotSignedInError";
    }
}

export function tokensPath(): string {
    return toolDataDir("alza", "tokens.json");
}

export function pendingLoginPath(): string {
    return toolDataDir("alza", "pending-login.json");
}

export function base64Url(buffer: Buffer): string {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest());
}

/** Accepts the whole `alza://identity?code=…&state=…` redirect, a `code=…&state=…` query, or a bare code. */
export function parseRedirect(pasted: string): { code: string; state?: string } {
    const text = pasted.trim();
    if (!text) {
        throw new Error("Nothing was pasted.");
    }

    if (!text.includes("=")) {
        return { code: text };
    }

    const params = new URLSearchParams(text.includes("?") ? text.slice(text.indexOf("?") + 1) : text);
    const error = params.get("error");
    if (error) {
        throw new Error(`Alza refused the sign-in: ${error} ${params.get("error_description") ?? ""}`.trim());
    }

    const code = params.get("code");
    if (!code) {
        throw new Error("The pasted value has no `code` parameter. Paste the full alza://identity?code=… URL.");
    }

    return { code, state: params.get("state") ?? undefined };
}

/** The JWT `exp` claim in epoch ms; undefined for an opaque or malformed token. */
export function jwtExpiryMs(token: string): number | undefined {
    const payload = token.split(".")[1];
    if (token.split(".").length !== 3 || !payload) {
        return undefined;
    }

    try {
        const claims: unknown = SafeJSON.parse(Buffer.from(payload, "base64url").toString("utf8"), { strict: true });
        if (typeof claims === "object" && claims !== null && "exp" in claims && typeof claims.exp === "number") {
            return claims.exp * 1000;
        }
    } catch (error) {
        logger.debug({ error }, "alza access token is not a readable JWT");
    }

    return undefined;
}

export function tokenExpiresAt(stored: Pick<StoredTokens, "expires_at">): number | undefined {
    if (!stored.expires_at) {
        return undefined;
    }

    const at = Date.parse(stored.expires_at);
    return Number.isFinite(at) ? at : undefined;
}

export function isExpiring(stored: Pick<StoredTokens, "expires_at">, now = Date.now()): boolean {
    const at = tokenExpiresAt(stored);
    return at !== undefined && at - now < EXPIRY_MARGIN_MS;
}

function readJsonFile<S extends z.ZodType>(schema: S, path: string): z.infer<S> | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = schema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        if (parsed.success) {
            return parsed.data;
        }

        logger.warn({ path, issues: parsed.error.issues.slice(0, 3) }, "alza account file has an unknown shape");
    } catch (error) {
        logger.warn({ error, path }, "alza account file is unreadable");
    }

    return undefined;
}

function writeSecretFile(path: string, value: unknown): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function removeFile(path: string): boolean {
    if (!existsSync(path)) {
        return false;
    }

    unlinkSync(path);
    return true;
}

export interface AlzaAuthOptions {
    http: ImpersonatedHttpClient;
    storefront: Storefront;
    visitorId: string;
    tokensFile?: string;
    pendingFile?: string;
}

/** The same sign-in: a refresh result may replace only the tokens it was renewed from. */
function sameSession(a: StoredTokens, b: StoredTokens): boolean {
    return a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

export class AlzaAuth {
    private readonly tokensFile: string;
    /**
     * Every change of the tokens file holds this lock, in every process: a long-running MCP server's refresh must not
     * write back tokens that a CLI logout removed, or that a new sign-in replaced, in the meantime.
     */
    private readonly lockFile: string;
    private readonly pendingFile: string;
    private refreshing?: Promise<StoredTokens>;

    constructor(private readonly options: AlzaAuthOptions) {
        this.tokensFile = options.tokensFile ?? tokensPath();
        this.lockFile = `${this.tokensFile}.lock`;
        this.pendingFile = options.pendingFile ?? pendingLoginPath();
    }

    /** The stored tokens as they are on disk. Reads only. */
    readTokens(): StoredTokens | undefined {
        return readJsonFile(storedTokensSchema, this.tokensFile);
    }

    /**
     * The access token for a real account call: undefined when nobody is signed in, refreshed first when it expires
     * within a minute. Re-reads the file each time, so a sign-in or a refresh by another process is picked up.
     */
    async accessToken(): Promise<string | undefined> {
        const stored = this.readTokens();
        if (!stored) {
            return undefined;
        }

        if (!isExpiring(stored)) {
            return stored.access_token;
        }

        if (!stored.refresh_token) {
            throw new NotSignedInError(`Your Alza session expired. ${SIGN_IN_HINT}`);
        }

        this.refreshing ??= this.refresh(stored).finally(() => {
            this.refreshing = undefined;
        });
        return (await this.refreshing).access_token;
    }

    /**
     * Saves the user id that Alza named for `accessToken`, only while the file still holds that token: a logout, a
     * sign-in to another account or a renewal in the meantime must not get this account's id.
     */
    async rememberUserId(userId: number, accessToken: string): Promise<void> {
        await this.withTokensLock(() => {
            const stored = this.readTokens();
            if (!stored || stored.user_id === userId || stored.access_token !== accessToken) {
                return;
            }

            writeSecretFile(this.tokensFile, { ...stored, user_id: userId });
        });
    }

    /** Step 1: a new PKCE pair and state, saved to the pending file; returns the URL to open in a browser. */
    async startLogin(): Promise<{ url: string }> {
        const discovery = await this.discovery();
        const verifier = base64Url(randomBytes(32));
        const state = base64Url(randomBytes(32));
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            response_type: "code",
            scope: SCOPE,
            redirect_uri: REDIRECT_URI,
            code_challenge_method: "S256",
            code_challenge: pkceChallenge(verifier),
            state,
            nonce: base64Url(randomBytes(32)),
            countryCode: this.options.storefront.country,
            culture: this.options.storefront.acceptLanguage.split(",")[0] ?? "cs-CZ",
        });
        const pending: PendingLogin = {
            verifier,
            state,
            created_at: new Date().toISOString(),
            token_endpoint: discovery.token_endpoint,
        };
        await this.withTokensLock(() => writeSecretFile(this.pendingFile, pending));
        logger.debug({ pendingFile: this.pendingFile }, "alza sign-in started");
        return { url: `${discovery.authorization_endpoint}?${params}` };
    }

    /** Step 2: exchanges the pasted redirect for tokens and saves them (0600). The pending file is removed. */
    async completeLogin(redirect: string): Promise<StoredTokens> {
        const pending = readJsonFile(pendingLoginSchema, this.pendingFile);
        if (!pending) {
            throw new Error(`No sign-in is waiting. Start one: ${toolCommand("alza auth login", "--print-url")}`);
        }

        if (Date.now() - Date.parse(pending.created_at) > PENDING_MAX_AGE_MS) {
            throw new Error(`The waiting sign-in is too old. Start again: ${toolCommand("alza auth login")}`);
        }

        const { code, state } = parseRedirect(redirect);
        if (state && state !== pending.state) {
            throw new Error(
                `The redirect belongs to another sign-in attempt (state mismatch). Start again: ${toolCommand("alza auth login")}`
            );
        }

        let tokens: StoredTokens;
        try {
            tokens = await this.tokenRequest(pending.token_endpoint, {
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: pending.verifier,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
                `${reason} The code is single-use and expires within minutes. Start again: ${toolCommand("alza auth login")}`
            );
        }

        if (!tokens.refresh_token) {
            logger.warn("alza sign-in returned no refresh token; the session ends when the access token expires");
        }

        // The exchange ran without the lock: a logout or a newer attempt in the meantime removed or replaced the pending
        // file, and this completion must neither sign the account back in nor delete the newer attempt.
        await this.withTokensLock(() => {
            const current = readJsonFile(pendingLoginSchema, this.pendingFile);
            if (!current || current.state !== pending.state || current.verifier !== pending.verifier) {
                throw new Error(
                    `The sign-in was cancelled while it completed (signed out, or a newer sign-in started). Start again: ${toolCommand("alza auth login")}`
                );
            }

            writeSecretFile(this.tokensFile, tokens);
            removeFile(this.pendingFile);
        });
        logger.debug({ tokensFile: this.tokensFile, expiresAt: tokens.expires_at }, "alza signed in");
        return tokens;
    }

    /**
     * Forgets the tokens and any waiting sign-in. The visitor basket state stays. Neither a refresh nor a sign-in
     * completion in flight can undo it.
     */
    async logout(): Promise<{ removed: boolean }> {
        return this.withTokensLock(() => {
            const removedTokens = removeFile(this.tokensFile);
            const removedPending = removeFile(this.pendingFile);
            logger.debug({ removedTokens, removedPending }, "alza signed out");
            return { removed: removedTokens };
        });
    }

    private withTokensLock<T>(change: () => T): Promise<T> {
        return withFileLock(this.lockFile, async () => change());
    }

    private async refresh(stale: StoredTokens): Promise<StoredTokens> {
        const discovery = await this.discovery();
        logger.debug({ expiresAt: stale.expires_at }, "alza access token expiring; refreshing");
        let fresh: StoredTokens;
        try {
            fresh = await this.tokenRequest(discovery.token_endpoint, {
                grant_type: "refresh_token",
                refresh_token: stale.refresh_token ?? "",
            });
        } catch (error) {
            logger.debug({ error }, "alza token refresh failed");
            throw new NotSignedInError(`Your Alza session could not be renewed. ${SIGN_IN_HINT}`);
        }

        const saved: StoredTokens = {
            ...fresh,
            refresh_token: fresh.refresh_token ?? stale.refresh_token,
            user_id: stale.user_id,
        };
        // The network round trip ran without the lock; commit only if the file still holds the session renewed here.
        return this.withTokensLock(() => {
            const current = this.readTokens();
            if (!current) {
                logger.debug("alza tokens removed while they were being renewed; the renewal is dropped");
                throw new NotSignedInError(`You signed out while the Alza session was being renewed. ${SIGN_IN_HINT}`);
            }

            if (!sameSession(current, stale)) {
                logger.debug("alza tokens changed while they were being renewed; keeping the stored ones");
                return current;
            }

            writeSecretFile(this.tokensFile, saved);
            return saved;
        });
    }

    private async tokenRequest(endpoint: string, fields: Record<string, string>): Promise<StoredTokens> {
        const body = new URLSearchParams({ ...fields, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
        const response = await this.options.http.request({
            url: endpoint,
            method: "POST",
            headers: {
                ...this.headers(),
                "content-type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });
        if (response.status < 200 || response.status >= 300) {
            const reason = /"error"\s*:\s*"([^"]+)"/.exec(response.text)?.[1];
            logger.debug({ endpoint, status: response.status, reason }, "alza token request refused");
            throw new Error(`The Alza token endpoint answered HTTP ${response.status}${reason ? ` (${reason})` : ""}.`);
        }

        const parsed = tokenResponseSchema.safeParse(SafeJSON.parse(response.text, { strict: true }));
        if (!parsed.success) {
            throw new Error("The Alza token endpoint answered without an access token.");
        }

        const now = Date.now();
        const expiresAtMs =
            jwtExpiryMs(parsed.data.access_token) ??
            (parsed.data.expires_in === undefined ? undefined : now + parsed.data.expires_in * 1000);
        return {
            access_token: parsed.data.access_token,
            refresh_token: parsed.data.refresh_token,
            token_type: parsed.data.token_type ?? "Bearer",
            scope: parsed.data.scope ?? SCOPE,
            expires_at: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
            obtained_at: new Date(now).toISOString(),
        };
    }

    /** Discovery is best effort: the IdP may challenge the GET, and the built-in endpoints are the APK defaults. */
    private async discovery(): Promise<z.infer<typeof discoverySchema>> {
        const fallback = {
            authorization_endpoint: `${AUTHORITY}/connect/authorize`,
            token_endpoint: `${AUTHORITY}/connect/token`,
        };
        try {
            const response = await this.options.http.request({
                url: `${AUTHORITY}/.well-known/openid-configuration`,
                headers: this.headers(),
            });
            if (response.status === 200) {
                const parsed = discoverySchema.safeParse(SafeJSON.parse(response.text, { strict: true }));
                if (parsed.success) {
                    return parsed.data;
                }
            }

            logger.warn({ status: response.status }, "alza OIDC discovery failed; using the default endpoints");
        } catch (error) {
            logger.warn({ error }, "alza OIDC discovery unreachable; using the default endpoints");
        }

        return fallback;
    }

    private headers(): Record<string, string> {
        return {
            accept: "application/json",
            "accept-language": this.options.storefront.acceptLanguage,
            "user-agent": APP_USER_AGENT,
            "x-correlation-id": randomUUID(),
            "Balancer-Guid": this.options.visitorId,
        };
    }
}
