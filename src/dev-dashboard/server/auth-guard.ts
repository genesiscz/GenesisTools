import type { DashboardAuthProvision } from "@app/dev-dashboard/config";
import { findEndpoint } from "@app/dev-dashboard/contract/endpoint-table";
import {
    allowsBrowserProvenance,
    buildSessionCookie,
    type CompleteDashboardAuthConfig,
    isCompleteAuthConfig,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";
import { isPublicShareRequest } from "@app/dev-dashboard/lib/share-auth";

export interface AuthInput {
    method: string;
    pathname: string;
    headers: Record<string, string>;
    provision: DashboardAuthProvision;
    requestUrl?: string;
    /** true when the request arrived over the HTTPS tunnel (sets Secure on the cookie). */
    secure?: boolean;
}

/** The header that carries a stored act token (`src/question/lib/act`). */
export const ACT_TOKEN_HEADER = "x-gt-act-token";

/** The shape `newActToken` mints: 128 random bits as base64url. Anything else never reaches the act door. */
const ACT_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The act scope: a request to an `act` row of the endpoint table (`POST /api/act`) that carries an act token passes
 * without the dashboard login. The token is the credential: it answers one letter of one decision, and the act door
 * refuses an unknown, expired or closed one. Every other row still needs the full login.
 */
export function isActScopedRequest(method: string, pathname: string, token: string | undefined): boolean {
    return typeof token === "string" && ACT_TOKEN_SHAPE.test(token) && findEndpoint(method, pathname)?.policy === "act";
}

export interface AuthResult {
    decision: "allow" | "deny" | "unconfigured";
    /** `act` when only the act token let the request through; absent for a full login (or no login needed). */
    scope?: "act";
    /** When set, the adapter must emit this as a Set-Cookie header. */
    setCookie?: string;
}

/** Pure mirror of requireDashboardAuth's decision matrix (vite-middleware.ts:115). */
export function decideApiAuth(input: AuthInput): AuthResult {
    const { method, pathname, headers, provision } = input;

    if (
        !allowsBrowserProvenance({
            method,
            requestUrl: input.requestUrl ?? `http://${headers.host ?? "localhost"}${pathname}`,
            origin: headers.origin,
            fetchSite: headers["sec-fetch-site"],
            host: headers.host,
            forwardedProto: headers["x-forwarded-proto"],
        })
    ) {
        return { decision: "deny" };
    }

    if (isPublicShareRequest(method, pathname)) {
        return { decision: "allow" };
    }

    if (isActScopedRequest(method, pathname, headers[ACT_TOKEN_HEADER])) {
        return { decision: "allow", scope: "act" };
    }

    if (headers[LOCAL_ORIGIN_HEADER] === "1") {
        return { decision: "allow" };
    }

    if (!provision.auth.enabled) {
        return { decision: "allow" };
    }

    if (!isCompleteAuthConfig(provision.auth)) {
        return { decision: "unconfigured" };
    }

    const auth: CompleteDashboardAuthConfig = provision.auth;

    if (verifySessionToken(headers.cookie ?? null, auth)) {
        return { decision: "allow" };
    }

    if (verifyBasicAuthHeader(headers.authorization ?? null, auth)) {
        return {
            decision: "allow",
            setCookie: buildSessionCookie(issueSessionToken(auth), { secure: input.secure === true }),
        };
    }

    return { decision: "deny" };
}
