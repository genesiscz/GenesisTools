import { describe, expect, test } from "bun:test";
import { isAuthStatus, isCredentialRejection, isSessionRedirect, isTimelyAuthFailure, TimelyHttpError } from "./errors";

describe("TimelyHttpError", () => {
    test("keeps the status and scope, and defaults usedCookie to false", () => {
        const err = new TimelyHttpError("nope", { status: 401, scope: "api" });

        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("TimelyHttpError");
        expect(err.status).toBe(401);
        expect(err.scope).toBe("api");
        expect(err.usedCookie).toBe(false);
    });
});

describe("isAuthStatus", () => {
    test("only 401 and 403 mean the credentials were refused", () => {
        expect(isAuthStatus(401)).toBe(true);
        expect(isAuthStatus(403)).toBe(true);
        expect(isAuthStatus(400)).toBe(false);
        expect(isAuthStatus(404)).toBe(false);
        expect(isAuthStatus(500)).toBe(false);
    });
});

describe("isSessionRedirect", () => {
    test("a redirect is how a web host refuses a session, so 3xx counts and nothing else does", () => {
        expect(isSessionRedirect(301)).toBe(true);
        expect(isSessionRedirect(302)).toBe(true);
        expect(isSessionRedirect(303)).toBe(true);
        expect(isSessionRedirect(200)).toBe(false);
        expect(isSessionRedirect(401)).toBe(false);
        expect(isSessionRedirect(500)).toBe(false);
    });
});

describe("isCredentialRejection", () => {
    test("covers both the API host's 401/403 and the web host's sign-in bounce", () => {
        expect(isCredentialRejection(401)).toBe(true);
        expect(isCredentialRejection(403)).toBe(true);
        expect(isCredentialRejection(302)).toBe(true);
        expect(isCredentialRejection(200)).toBe(false);
        expect(isCredentialRejection(500)).toBe(false);
    });
});

describe("isTimelyAuthFailure", () => {
    test("narrows only Timely auth failures, not other errors or statuses", () => {
        expect(isTimelyAuthFailure(new TimelyHttpError("nope", { status: 403, scope: "memories" }))).toBe(true);
        expect(isTimelyAuthFailure(new TimelyHttpError("boom", { status: 500, scope: "memories" }))).toBe(false);
        expect(isTimelyAuthFailure(new Error("socket hang up"))).toBe(false);
        expect(isTimelyAuthFailure(undefined)).toBe(false);
    });

    test("a sign-in redirect is an auth failure, so callers abort instead of reporting empty days", () => {
        expect(isTimelyAuthFailure(new TimelyHttpError("bounced", { status: 302, scope: "memories" }))).toBe(true);
    });
});
