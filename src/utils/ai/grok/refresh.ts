/**
 * OIDC refresh-token grant for `~/.grok/auth.json`.
 *
 * The auth file already carries everything the grant needs (`refresh_token`,
 * `oidc_issuer`, `oidc_client_id`), but nothing ever used them: an expired
 * access token could only be fixed by running the `grok` CLI by hand, which is
 * unusable for a background daemon. This performs the refresh itself.
 *
 * Two hazards shape the implementation. The `grok` CLI may be refreshing the
 * same file concurrently, so the rewrite is temp-file + rename (a reader sees
 * either the old file or the new one, never a torn one) and the file is re-read
 * immediately before writing so a fresher token from the CLI wins instead of
 * being clobbered. And several in-flight proxy requests can notice the expiry at
 * the same moment, so refreshes are single-flighted per auth path — one network
 * call, one rotation, no burnt refresh tokens.
 */
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { SafeJSON } from "@genesiscz/utils/json";
import { decodeJwt } from "@genesiscz/utils/jwt";
import { logger } from "@genesiscz/utils/logger";
import { decodeJwtClaims, isAuthEntry, isTokenExpired, readAuthFileAsync } from "./auth";
import { GrokAuthExpiredError } from "./auth-errors";
import { grokAuthPath } from "./paths";
import type { GrokAuthEntry } from "./types";

const AUTH_FILE_MODE = 0o600;
/** Both calls sit on the request path of live proxy requests, so neither may hang. */
const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 15_000;

const inflight = new Map<string, Promise<string | null>>();

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
}

function activeEntryId(entries: Map<string, GrokAuthEntry>): string | undefined {
    for (const [id, entry] of entries) {
        if (entry.key.length > 0) {
            return id;
        }
    }

    return undefined;
}

/** Ask the issuer where its token endpoint is; fall back to the conventional path. */
async function resolveTokenEndpoint(issuer: string): Promise<string> {
    const base = issuer.replace(/\/$/, "");

    try {
        const response = await fetch(`${base}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });

        if (response.ok) {
            const discovery = SafeJSON.parse(await response.text(), { strict: true }) as { token_endpoint?: string };

            if (typeof discovery.token_endpoint === "string" && discovery.token_endpoint.length > 0) {
                return discovery.token_endpoint;
            }
        }

        logger.debug({ issuer, status: response.status }, "grok refresh: discovery unusable, using default endpoint");
    } catch (err) {
        logger.debug({ err, issuer }, "grok refresh: discovery request failed, using default endpoint");
    }

    return `${base}/oauth2/token`;
}

/**
 * The parsed entry map is a filtered VIEW of auth.json: `parseAuthEntries` drops
 * every top-level value that is not a live entry (a logged-out slot with an
 * empty `key`, a `settings` object, a scalar version marker). Rebuilding the
 * file from that map would delete all of it, so the rewrite patches the raw
 * document and the map is used only to reason about entries.
 */
async function readAuthDocument(
    authPath: string,
    knownEntries: Map<string, GrokAuthEntry>
): Promise<Record<string, unknown>> {
    try {
        // Lenient, matching `readAuthFileAsync`. A stricter parse here would
        // reject files the reader accepted (a trailing comma is enough), fall
        // through to the fallback, and drop everything this function exists to
        // keep — the exact data loss it was written to prevent.
        const parsed = SafeJSON.parse(await Bun.file(authPath).text());

        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }

        logger.warn({ authPath }, "grok refresh: auth file is not a JSON object, rewriting it from known entries");
    } catch (err) {
        logger.warn({ err, authPath }, "grok refresh: auth file unreadable before rewrite, keeping known entries");
    }

    // Still every entry the initial read saw, rather than an empty document:
    // losing the non-entry fields is bad, losing the other accounts is worse.
    return Object.fromEntries(knownEntries);
}

async function writeAuthFileAtomically(authPath: string, document: Record<string, unknown>): Promise<void> {
    const temp = `${authPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${SafeJSON.stringify(document, { strict: true }, 2)}\n`;

    // The temp file holds the access AND refresh tokens, so a failure after it
    // exists must not leave it lying around at whatever mode it got. `writeFile`
    // mode is masked by umask (umask 0600 yields a 000 file), which is why the
    // chmod follows rather than being redundant with it.
    try {
        await writeFile(temp, payload, { mode: AUTH_FILE_MODE });
        await chmod(temp, AUTH_FILE_MODE);
        await rename(temp, authPath);
    } catch (err) {
        try {
            await unlink(temp);
        } catch (cleanupErr) {
            logger.warn({ err: cleanupErr, temp }, "grok refresh: could not remove the temp auth file after a failure");
        }

        throw err;
    }
}

/** Token-shaped runs, which some issuers echo back inside their error payloads. */
function redactTokens(text: string): string {
    return text.replace(/[A-Za-z0-9._~+/-]{20,}={0,2}/g, "<redacted>");
}

/**
 * A refusal is worth logging, the raw body is not: OAuth error payloads
 * sometimes quote the submitted `refresh_token` back at you.
 */
function describeTokenError(body: string): string {
    try {
        const parsed = SafeJSON.parse(body, { strict: true }) as { error?: unknown; error_description?: unknown };
        const parts = [parsed.error, parsed.error_description].filter(
            (part): part is string => typeof part === "string"
        );

        if (parts.length > 0) {
            return redactTokens(parts.join(": "));
        }
    } catch (err) {
        logger.debug({ err }, "grok refresh: token endpoint error body is not JSON");
    }

    return redactTokens(body).slice(0, 200);
}

async function performRefresh(authPath: string, force: boolean): Promise<string | null> {
    const entries = await readAuthFileAsync(authPath);
    const id = activeEntryId(entries);
    const entry = id ? entries.get(id) : undefined;

    if (!id || !entry) {
        logger.warn({ authPath }, "grok refresh: no auth entry to refresh");
        return null;
    }

    // The CLI (or another process) may already have refreshed while we queued.
    // `force` skips this: a token the upstream just rejected is usually still
    // time-valid, and an undecodable token reads as "fresh" here too.
    if (!force && !isTokenExpired(decodeJwtClaims(entry.key))) {
        logger.debug({ authPath }, "grok refresh: on-disk token is already fresh");
        return entry.key;
    }

    if (!entry.refresh_token || !entry.oidc_issuer || !entry.oidc_client_id) {
        logger.warn(
            {
                authPath,
                hasRefreshToken: Boolean(entry.refresh_token),
                hasIssuer: Boolean(entry.oidc_issuer),
                hasClientId: Boolean(entry.oidc_client_id),
            },
            "grok refresh: auth entry lacks the fields an OIDC refresh needs"
        );

        return null;
    }

    const endpoint = await resolveTokenEndpoint(entry.oidc_issuer);
    const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: entry.refresh_token,
            client_id: entry.oidc_client_id,
        }).toString(),
    });

    if (!response.ok) {
        logger.warn(
            { authPath, endpoint, status: response.status, reason: describeTokenError(await response.text()) },
            "grok refresh: token endpoint rejected the refresh grant"
        );

        return null;
    }

    const payload = SafeJSON.parse(await response.text(), { strict: true }) as TokenResponse;

    if (!payload.access_token) {
        logger.warn({ authPath, endpoint }, "grok refresh: token endpoint returned no access_token");
        return null;
    }

    // Re-read right before writing: whatever the CLI wrote in the meantime keeps
    // its other entries, and only this entry's tokens are replaced.
    const document = await readAuthDocument(authPath, entries);
    const onDisk = document[id];
    const target = isAuthEntry(onDisk) ? onDisk : entry;

    // …unless the CLI refreshed THIS entry while the grant was in flight. Its
    // rotated refresh token is the one the issuer now expects, so overwriting it
    // with ours would break the next refresh. Its access token is usable, so use it.
    if (target.key !== entry.key && !isTokenExpired(decodeJwtClaims(target.key))) {
        logger.info({ authPath }, "grok refresh: another writer refreshed this entry mid-grant, keeping its token");
        return target.key;
    }

    const claims = decodeJwt(payload.access_token);
    const expSec =
        claims.ok && typeof (claims.payload as { exp?: number }).exp === "number"
            ? (claims.payload as { exp?: number }).exp
            : payload.expires_in
              ? Math.floor(Date.now() / 1000) + payload.expires_in
              : undefined;

    const next: GrokAuthEntry = {
        ...target,
        key: payload.access_token,
        refresh_token: payload.refresh_token ?? target.refresh_token,
        expires_at: expSec ? new Date(expSec * 1000).toISOString() : target.expires_at,
    };

    document[id] = next;
    await writeAuthFileAtomically(authPath, document);

    logger.info(
        {
            authPath,
            endpoint,
            rotatedRefreshToken: Boolean(payload.refresh_token),
            expiresAt: next.expires_at,
        },
        "grok refresh: access token refreshed via OIDC and auth.json rewritten"
    );

    return payload.access_token;
}

/**
 * Refresh and insist on a usable result: the shared "a refresh that cannot be
 * attempted or that the issuer rejects is fatal" contract.
 *
 * Both callers (`resolveGrokSubToken` and `GrokSubscriptionClient`) need exactly
 * this and only differ in what they log and what they do with the token, so the
 * rule about when an expired token becomes a `GrokAuthExpiredError` lives here
 * rather than in two places that can disagree.
 */
export async function refreshGrokAuthOrThrow(options: {
    authPath: string;
    force?: boolean;
    /** Included in both log lines so a caller's context survives into the log. */
    context: Record<string, unknown>;
    onSuccess: string;
    onFailure: string;
}): Promise<string> {
    const refreshed = await refreshGrokAuth({ path: options.authPath, force: options.force });

    if (!refreshed || isTokenExpired(decodeJwtClaims(refreshed))) {
        logger.warn({ authPath: options.authPath, ...options.context }, options.onFailure);
        throw new GrokAuthExpiredError(options.authPath);
    }

    logger.info({ authPath: options.authPath, ...options.context }, options.onSuccess);

    return refreshed;
}

export interface RefreshGrokAuthOptions {
    /** Auth file to refresh. Defaults to the Grok CLI's `~/.grok/auth.json`. */
    path?: string;
    /**
     * Refresh even when the on-disk token still looks unexpired. The 401-recovery
     * path needs this: a revoked token is normally still inside its `exp`, and a
     * token whose claims cannot be decoded also reads as "not expired".
     */
    force?: boolean;
}

/**
 * Refresh the Grok access token in `auth.json` and return the new one, or null
 * when the file cannot be refreshed (missing fields, issuer refused). Concurrent
 * callers on the same path share one refresh.
 */
export function refreshGrokAuth(options?: RefreshGrokAuthOptions): Promise<string | null> {
    const authPath = options?.path ?? grokAuthPath();
    const force = options?.force ?? false;
    // A soft refresh in flight may return the very token a forced caller was
    // just rejected for, so the two kinds never share a promise.
    const key = `${force ? "force" : "soft"}::${authPath}`;
    const existing = inflight.get(key);

    if (existing) {
        return existing;
    }

    const next = performRefresh(authPath, force)
        .catch((err: unknown) => {
            logger.warn({ err, authPath, force }, "grok refresh: refresh attempt failed");
            return null;
        })
        .finally(() => {
            inflight.delete(key);
        });

    inflight.set(key, next);

    return next;
}
