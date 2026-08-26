/**
 * Port of chrome-har lib/cookies.js (v1.3.1, MIT). Behavior kept 1:1;
 * tough-cookie retained.
 *
 * Known inherited quirk, kept for parity: a NUMERIC `expires` from CDP
 * associatedCookies is in SECONDS, but the `new Date(expires)` branch below
 * interprets it as MILLISECONDS — upstream does the same and the parity goldens
 * pin that output. Do not multiply by 1000 unless upstream changes.
 */
import { Cookie } from "tough-cookie";
import type { CdpAssociatedCookie, HarCookie } from "./types.ts";

export function formatCookie(cookie: CdpAssociatedCookie["cookie"] | Cookie): HarCookie {
    let expiresISO: string | undefined;
    const expires = cookie.expires;

    if (expires instanceof Date) {
        expiresISO = expires.toISOString();
    } else if (expires === "Infinity" || expires === null || expires === undefined) {
        expiresISO = undefined;
    } else {
        const date = new Date(expires);
        expiresISO = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    const key = "key" in cookie ? cookie.key : undefined;

    return {
        name: key || ("name" in cookie ? (cookie.name ?? "") : ""),
        value: cookie.value,
        path: cookie.path || undefined,
        domain: cookie.domain || undefined,
        expires: expiresISO,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
    };
}

function parseCookie(cookieString: string): HarCookie | undefined {
    const cookie = Cookie.parse(cookieString);
    if (!cookie) {
        return undefined;
    }

    return formatCookie(cookie);
}

function splitAndParse(header: string, divider: string): HarCookie[] {
    return header
        .split(divider)
        .filter(Boolean)
        .map((element) => parseCookie(element))
        .filter((c): c is HarCookie => Boolean(c));
}

export function parseRequestCookies(cookieHeader: string): HarCookie[] {
    return splitAndParse(cookieHeader, ";");
}

export function parseResponseCookies(cookieHeader: string): HarCookie[] {
    return splitAndParse(cookieHeader, "\n");
}
