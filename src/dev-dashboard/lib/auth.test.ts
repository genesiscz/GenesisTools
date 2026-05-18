import { describe, expect, test } from "bun:test";
import {
    buildSessionCookie,
    createBasicAuthCredentials,
    issueSessionToken,
    makeBasicAuthHeader,
    parseCookieHeader,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";

describe("dashboard auth", () => {
    test("generated credentials verify matching basic auth header", () => {
        const { auth, password } = createBasicAuthCredentials({ username: "martin", password: "secret-pass" });
        const header = makeBasicAuthHeader({ username: "martin", password });

        expect(verifyBasicAuthHeader(header, auth)).toBe(true);
    });

    test("rejects wrong passwords", () => {
        const { auth } = createBasicAuthCredentials({ username: "martin", password: "secret-pass" });
        const header = makeBasicAuthHeader({ username: "martin", password: "wrong-pass" });

        expect(verifyBasicAuthHeader(header, auth)).toBe(false);
    });

    test("rejects malformed or missing headers", () => {
        const { auth } = createBasicAuthCredentials({ username: "martin", password: "secret-pass" });

        expect(verifyBasicAuthHeader(null, auth)).toBe(false);
        expect(verifyBasicAuthHeader("Bearer nope", auth)).toBe(false);
        expect(verifyBasicAuthHeader("Basic not-base64", auth)).toBe(false);
    });
});

describe("dashboard session cookie", () => {
    const { auth } = createBasicAuthCredentials({ username: "martin", password: "secret-pass" });

    test("issued token verifies from a Cookie header", () => {
        const token = issueSessionToken(auth);

        expect(verifySessionToken(`dd_session=${token}`, auth)).toBe(true);
        expect(verifySessionToken(`other=x; dd_session=${token}; trailing=y`, auth)).toBe(true);
    });

    test("rejects missing, malformed, or tampered tokens", () => {
        const token = issueSessionToken(auth);

        expect(verifySessionToken(null, auth)).toBe(false);
        expect(verifySessionToken("", auth)).toBe(false);
        expect(verifySessionToken("dd_session=nodot", auth)).toBe(false);
        expect(verifySessionToken(`dd_session=${token}x`, auth)).toBe(false);
        const [payload, sig] = token.split(".");
        expect(verifySessionToken(`dd_session=${payload}.${sig.slice(0, -2)}00`, auth)).toBe(false);
        expect(verifySessionToken(`dd_session=${Buffer.from('{"v":1}').toString("base64url")}.deadbeef`, auth)).toBe(
            false
        );
    });

    test("rejects an expired token", () => {
        const token = issueSessionToken(auth);

        expect(verifySessionToken(`dd_session=${token}`, auth, 0)).toBe(false);
    });

    test("rejects a future-dated (iat > now) token", () => {
        const realNow = Date.now;
        let futureToken = "";

        try {
            Date.now = () => realNow() + 60_000;
            futureToken = issueSessionToken(auth);
        } finally {
            Date.now = realNow;
        }

        // Without the issued-in-the-past guard this would validate (now - iat
        // is negative, so < maxAgeMs is trivially true) and never expire.
        expect(verifySessionToken(`dd_session=${futureToken}`, auth)).toBe(false);
    });

    test("rejects a token signed with a different password (post `auth reset`)", () => {
        const token = issueSessionToken(auth);
        const { auth: rotated } = createBasicAuthCredentials({ username: "martin", password: "new-pass" });

        expect(verifySessionToken(`dd_session=${token}`, rotated)).toBe(false);
    });

    test("buildSessionCookie sets hardening attributes; Secure only when asked", () => {
        const open = buildSessionCookie("tok", { secure: false });
        const secure = buildSessionCookie("tok", { secure: true });

        expect(open).toContain("dd_session=tok");
        expect(open).toContain("HttpOnly");
        expect(open).toContain("SameSite=Lax");
        expect(open).toContain("Path=/");
        expect(open).toContain("Max-Age=604800");
        expect(open).not.toContain("Secure");
        expect(secure).toContain("Secure");
    });

    test("parseCookieHeader ignores junk and parses pairs", () => {
        expect(parseCookieHeader(null)).toEqual({});
        expect(parseCookieHeader("a=1; b=2; ; =nope; bad")).toEqual({ a: "1", b: "2" });
    });
});
