import { describe, expect, test } from "bun:test";
import {
    describeCookie,
    extractCookie,
    looksLikeCookiePairs,
    normalizeCookieHeader,
    shellTokens,
    webSessionHeaders,
} from "./cookie";

const COOKIE = "login_form_alert=1; _memory_session=abc%3D%3D; ajs_group_id=558481; tic-session=zzz";

describe("normalizeCookieHeader", () => {
    test("keeps a plain pasted header", () => {
        expect(normalizeCookieHeader("_memory_session=abc; revision=12")).toBe("_memory_session=abc; revision=12");
    });

    test("strips the copied 'Cookie:' label", () => {
        expect(normalizeCookieHeader("Cookie: _memory_session=abc")).toBe("_memory_session=abc");
        expect(normalizeCookieHeader("cookie:_memory_session=abc")).toBe("_memory_session=abc");
    });

    test("strips wrapping quotes and whitespace", () => {
        expect(normalizeCookieHeader('  "_memory_session=abc"  ')).toBe("_memory_session=abc");
    });
});

describe("webSessionHeaders", () => {
    test("sends the cookie alongside the bearer", () => {
        const headers = webSessionHeaders({ accessToken: "tok", cookie: "_memory_session=abc" });

        expect(headers.Cookie).toBe("_memory_session=abc");
        expect(headers.Authorization).toBe("Bearer tok");
    });

    test("omits the Cookie header when none is stored", () => {
        const headers = webSessionHeaders({ accessToken: "tok" });

        expect(headers.Cookie).toBeUndefined();
        expect(headers.Authorization).toBe("Bearer tok");
    });
});

describe("extractCookie", () => {
    test("reads -b from a backslash-continued curl copied from DevTools", () => {
        const pasted = `curl 'https://app.timelyapp.com/558481/suggested_hours?since=2026-08-03&until=2026-08-09' \\
  -H 'accept: application/json' \\
  -b '${COOKIE}' \\
  -H 'referer: https://app.timelyapp.com/558481/calendar/week?date=2026-08-03'`;

        expect(extractCookie(pasted)).toEqual({ cookie: COOKIE, source: "curl-cookie-flag" });
    });

    test("reads --cookie with double quotes", () => {
        expect(extractCookie(`curl "https://app.timelyapp.com/558481/x" --cookie "${COOKIE}"`)).toEqual({
            cookie: COOKIE,
            source: "curl-cookie-flag",
        });
    });

    test("reads -H 'cookie: …' and -H 'Cookie: …'", () => {
        expect(extractCookie(`curl 'https://x' -H 'cookie: ${COOKIE}'`)).toEqual({
            cookie: COOKIE,
            source: "curl-header-flag",
        });
        expect(extractCookie(`curl 'https://x' -H "Cookie: ${COOKIE}"`)).toEqual({
            cookie: COOKIE,
            source: "curl-header-flag",
        });
        expect(extractCookie(`curl 'https://x' --header 'Cookie: ${COOKIE}'`)).toEqual({
            cookie: COOKIE,
            source: "curl-header-flag",
        });
    });

    test("reads Chrome's $'…' ANSI-C quoting", () => {
        const withQuote = `sess=a\\'b; other=2`;
        expect(extractCookie(`curl 'https://x' -b $'${withQuote}'`)).toEqual({
            cookie: "sess=a'b; other=2",
            source: "curl-cookie-flag",
        });
    });

    test("never mistakes the URL or another header for the cookie", () => {
        const noCookie = `curl 'https://app.timelyapp.com/558481/suggested_hours?since=2026-08-03' \\
  -H 'accept: application/json' \\
  -H 'referer: https://app.timelyapp.com/558481/calendar/week'`;

        expect(extractCookie(noCookie)).toBeUndefined();
    });

    test("accepts a bare Cookie: header line, with or without a trailing continuation", () => {
        expect(extractCookie(`Cookie: ${COOKIE}`)).toEqual({ cookie: COOKIE, source: "header-line" });
        expect(extractCookie(`cookie: ${COOKIE} \\`)).toEqual({ cookie: COOKIE, source: "header-line" });
    });

    test("accepts a bare name=v; name2=v2 string", () => {
        expect(extractCookie(COOKIE)).toEqual({ cookie: COOKIE, source: "raw-pairs" });
        expect(extractCookie(`  ${COOKIE}  `)).toEqual({ cookie: COOKIE, source: "raw-pairs" });
    });

    test("finds the cookie line inside a pasted request-headers block", () => {
        const block = `:authority: app.timelyapp.com
accept: application/json
Cookie: ${COOKIE}
referer: https://app.timelyapp.com/558481/calendar/week`;

        expect(extractCookie(block)).toEqual({ cookie: COOKIE, source: "header-line" });
    });

    test("returns undefined for empty or unusable input", () => {
        expect(extractCookie("")).toBeUndefined();
        expect(extractCookie("   \n  ")).toBeUndefined();
        expect(extractCookie("https://app.timelyapp.com/558481/calendar/week?date=2026-08-03")).toBeUndefined();
        expect(extractCookie("just some words the user copied by mistake")).toBeUndefined();
    });
});

// Expectations below are the output of the same string run through bash itself.
describe("shellTokens", () => {
    test("a backslash pair inside $'…' collapses to one, instead of doubling", () => {
        expect(shellTokens(String.raw`curl -b $'sess=a\\b; x=1'`)).toEqual(["curl", "-b", String.raw`sess=a\b; x=1`]);
    });

    test("a trailing backslash pair cannot escape the closing quote and swallow the next flag", () => {
        expect(shellTokens(String.raw`curl -b $'sess=a\\' -H 'accept: application/json'`)).toEqual([
            "curl",
            "-b",
            "sess=a\\",
            "-H",
            "accept: application/json",
        ]);
    });

    test("a plain '…' keeps a backslash literal, the way a shell does", () => {
        expect(shellTokens(String.raw`curl -b 'sess=a\b'`)).toEqual(["curl", "-b", String.raw`sess=a\b`]);
    });
});

describe("looksLikeCookiePairs", () => {
    test("accepts real cookie strings and rejects URLs and header values", () => {
        expect(looksLikeCookiePairs(COOKIE)).toBe(true);
        expect(looksLikeCookiePairs("one=1")).toBe(true);
        expect(looksLikeCookiePairs("https://app.timelyapp.com/558481/x?since=2026-08-03")).toBe(false);
        expect(looksLikeCookiePairs("accept: application/json")).toBe(false);
        expect(looksLikeCookiePairs("")).toBe(false);
    });
});

describe("describeCookie", () => {
    test("names the cookies without revealing a single value", () => {
        const described = describeCookie(COOKIE);

        expect(described).toBe("4 cookies: login_form_alert, _memory_session, ajs_group_id, tic-session");
        expect(described).not.toContain("abc%3D%3D");
        expect(described).not.toContain("558481");
    });

    test("caps the list for a long cookie", () => {
        expect(describeCookie("a=1; b=2; c=3; d=4; e=5; f=6")).toBe("6 cookies: a, b, c, d, +2 more");
    });
});
