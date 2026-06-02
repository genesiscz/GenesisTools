import type { DashboardAuthProvision } from "@app/dev-dashboard/config";
import {
    buildSessionCookie,
    type CompleteDashboardAuthConfig,
    isCompleteAuthConfig,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";

const SHARE_BYPASS_RE = /^\/share\/[^/]+$/;

export interface AuthInput {
    method: string;
    pathname: string;
    headers: Record<string, string>;
    provision: DashboardAuthProvision;
    /** true when the request arrived over the HTTPS tunnel (sets Secure on the cookie). */
    secure?: boolean;
}

export interface AuthResult {
    decision: "allow" | "deny" | "unconfigured";
    /** When set, the adapter must emit this as a Set-Cookie header. */
    setCookie?: string;
}

/** Pure mirror of requireDashboardAuth's decision matrix (vite-middleware.ts:115). */
export function decideApiAuth(input: AuthInput): AuthResult {
    const { method, pathname, headers, provision } = input;

    if (method === "GET" && SHARE_BYPASS_RE.test(pathname)) {
        return { decision: "allow" };
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
