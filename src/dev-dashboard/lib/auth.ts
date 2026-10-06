import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { makeBasicAuthHeader, parseBasicAuthHeader } from "@app/dev-dashboard/contract/auth-header";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

// The pure base64 Basic-Auth codec moved into the RN-safe contract (plan 02 Task 0);
// re-exported here so the Agent's existing import paths keep working unchanged.
export { makeBasicAuthHeader, parseBasicAuthHeader };

export interface DashboardAuthConfig {
    enabled: boolean;
    username: string;
    passwordSalt?: string;
    passwordHash?: string;
}

export interface CompleteDashboardAuthConfig extends DashboardAuthConfig {
    passwordSalt: string;
    passwordHash: string;
}

interface CreateBasicAuthOptions {
    username?: string;
    password?: string;
    salt?: string;
}

const PASSWORD_KEY_LENGTH = 32;

function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex");
}

function secureHexEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createBasicAuthCredentials(options: CreateBasicAuthOptions = {}): {
    auth: CompleteDashboardAuthConfig;
    password: string;
} {
    const username = options.username ?? "martin";
    const password = options.password ?? randomBytes(24).toString("base64url");
    const passwordSalt = options.salt ?? randomBytes(16).toString("base64url");

    return {
        auth: {
            enabled: true,
            username,
            passwordSalt,
            passwordHash: hashPassword(password, passwordSalt),
        },
        password,
    };
}

export function isCompleteAuthConfig(auth: DashboardAuthConfig): auth is CompleteDashboardAuthConfig {
    return Boolean(auth.passwordHash && auth.passwordSalt);
}

export function verifyBasicAuthHeader(header: string | null, auth: CompleteDashboardAuthConfig): boolean {
    const parsed = parseBasicAuthHeader(header);

    if (!parsed || parsed.username !== auth.username) {
        return false;
    }

    return secureHexEqual(hashPassword(parsed.password, auth.passwordSalt), auth.passwordHash);
}

// Single source of truth for the loopback-trust header. The front-proxy sets
// it ONLY for a genuine localhost origin and strips any inbound copy; the Vite
// auth middleware trusts it to skip Basic Auth for localhost. Both modules MUST
// reference this exact name — if the set/strip side and the trust side ever
// desync, an attacker-supplied header could go un-stripped and bypass auth
// (fail-open). Defined here because auth.ts is the one module both already
// import.
export const LOCAL_ORIGIN_HEADER = "x-dd-local-origin";

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
type HeaderValue = string | readonly string[] | null | undefined;

function firstHeaderValue(value: HeaderValue): string | undefined {
    return typeof value === "string" ? value : value?.[0];
}

export function allowsBrowserProvenance({
    method,
    requestUrl,
    origin,
    fetchSite,
    host,
    forwardedProto,
    force = false,
}: {
    method: string;
    requestUrl: string;
    origin: HeaderValue;
    fetchSite: HeaderValue;
    host: HeaderValue;
    forwardedProto: HeaderValue;
    force?: boolean;
}): boolean {
    if (!force && SAFE_HTTP_METHODS.has(method.toUpperCase())) {
        return true;
    }

    const originValue = firstHeaderValue(origin);
    const fetchSiteValue = firstHeaderValue(fetchSite);
    const hostValue = firstHeaderValue(host);
    const forwardedProtoValue = firstHeaderValue(forwardedProto);

    if (fetchSiteValue?.toLowerCase() === "cross-site") {
        return false;
    }

    if (originValue === undefined || originValue === "") {
        return true;
    }

    if (originValue === "null") {
        return false;
    }

    try {
        const request = new URL(requestUrl);
        const protocol = forwardedProtoValue?.split(",")[0]?.trim() || request.protocol.replace(/:$/, "");
        const destination = new URL(`${protocol}://${hostValue || request.host}`).origin;
        return new URL(originValue).origin === destination;
    } catch {
        return false;
    }
}

// Browser-initiated WebSocket handshakes cannot carry an Authorization header,
// so the ttyd terminal + HMR sockets (which bypass the Vite auth middleware via
// the front-proxy) are gated by a signed session cookie instead. The cookie is
// HMAC-bound to the password material, so `auth reset` invalidates every
// outstanding session. SameSite=Lax additionally denies the cookie to
// cross-site requests, hardening the JSON API against CSRF for free.

const SESSION_COOKIE_NAME = "dd_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SIGNATURE_LENGTH = 64;
const MAX_SESSION_PAYLOAD_LENGTH = 256;

interface SessionPayload {
    v: 1;
    iat: number;
}

interface SessionSecretCache {
    passwordHash: string;
    passwordSalt: string;
    secret: Buffer;
}

let sessionSecretCache: SessionSecretCache | undefined;

function deriveSessionSecret(auth: CompleteDashboardAuthConfig): Buffer {
    if (
        sessionSecretCache?.passwordHash === auth.passwordHash &&
        sessionSecretCache.passwordSalt === auth.passwordSalt
    ) {
        return sessionSecretCache.secret;
    }

    sessionSecretCache?.secret.fill(0);
    const secret = scryptSync(`${auth.passwordHash}:${auth.passwordSalt}`, "dd-session-v1", PASSWORD_KEY_LENGTH);
    sessionSecretCache = { passwordHash: auth.passwordHash, passwordSalt: auth.passwordSalt, secret };

    return secret;
}

function signSessionPayload(encodedPayload: string, secret: Buffer): string {
    return createHmac("sha256", secret).update(encodedPayload).digest("hex");
}

export function issueSessionToken(auth: CompleteDashboardAuthConfig): string {
    const payload: SessionPayload = { v: 1, iat: Date.now() };
    const encoded = Buffer.from(SafeJSON.stringify(payload), "utf8").toString("base64url");

    return `${encoded}.${signSessionPayload(encoded, deriveSessionSecret(auth))}`;
}

export function buildSessionCookie(token: string, opts: { secure: boolean }): string {
    const attrs = [
        `${SESSION_COOKIE_NAME}=${token}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
    ];

    if (opts.secure) {
        attrs.push("Secure");
    }

    return attrs.join("; ");
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};

    if (!header) {
        return out;
    }

    for (const part of header.split(";")) {
        const eq = part.indexOf("=");

        if (eq < 1) {
            continue;
        }

        const name = part.slice(0, eq).trim();

        if (name) {
            out[name] = part.slice(eq + 1).trim();
        }
    }

    return out;
}

export function verifySessionToken(
    cookieHeader: string | null | undefined,
    auth: CompleteDashboardAuthConfig,
    maxAgeMs: number = SESSION_MAX_AGE_MS
): boolean {
    const token = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];

    if (!token) {
        return false;
    }

    const dot = token.indexOf(".");

    if (dot < 1) {
        return false;
    }

    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    // Reject impossible shapes before the synchronous KDF. Buffer.from(_, "hex")
    // silently drops trailing non-hex, so both exact length and alphabet matter.
    if (
        encoded.length === 0 ||
        encoded.length > MAX_SESSION_PAYLOAD_LENGTH ||
        signature.length !== SESSION_SIGNATURE_LENGTH ||
        !/^[0-9a-f]+$/.test(signature)
    ) {
        return false;
    }

    const expected = signSessionPayload(encoded, deriveSessionSecret(auth));
    if (!secureHexEqual(signature, expected)) {
        return false;
    }

    let payload: SessionPayload;

    try {
        payload = SafeJSON.parse(Buffer.from(encoded, "base64url").toString("utf8"), {
            strict: true,
        }) as SessionPayload;
    } catch (err) {
        logger.debug({ err }, "dev-dashboard: rejected session cookie with unparseable payload");
        return false;
    }

    if (payload.v !== 1 || typeof payload.iat !== "number") {
        return false;
    }

    const now = Date.now();

    // Require issued-in-the-past AND not-expired: a future-dated iat must not
    // validate (it would otherwise never expire). Forging iat needs the HMAC
    // secret, so this is clock-skew / defense-in-depth robustness, not the
    // primary control.
    return payload.iat <= now && now - payload.iat < maxAgeMs;
}
