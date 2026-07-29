import { describe, expect, test } from "bun:test";
import { isAuthStatus, isTimelyAuthFailure, TimelyHttpError } from "./errors";

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

describe("isTimelyAuthFailure", () => {
    test("narrows only Timely auth failures, not other errors or statuses", () => {
        expect(isTimelyAuthFailure(new TimelyHttpError("nope", { status: 403, scope: "memories" }))).toBe(true);
        expect(isTimelyAuthFailure(new TimelyHttpError("boom", { status: 500, scope: "memories" }))).toBe(false);
        expect(isTimelyAuthFailure(new Error("socket hang up"))).toBe(false);
        expect(isTimelyAuthFailure(undefined)).toBe(false);
    });
});
