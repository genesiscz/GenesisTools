import { describe, expect, it } from "bun:test";
import { errorCodeOf, isLoginRequiredError, LOGIN_REQUIRED_CODE } from "./login-required";

class CodedError extends Error {
    constructor(
        message: string,
        public readonly code?: string
    ) {
        super(message);
    }
}

describe("isLoginRequiredError", () => {
    it("matches by stable code regardless of message copy", () => {
        expect(isLoginRequiredError(new CodedError("please sign in", LOGIN_REQUIRED_CODE))).toBe(true);
        expect(isLoginRequiredError(new CodedError("boom", "rate_limited"))).toBe(false);
    });

    it("falls back to the legacy message string", () => {
        expect(isLoginRequiredError(new Error("login required"))).toBe(true);
        expect(isLoginRequiredError("login required")).toBe(true);
        expect(isLoginRequiredError(new Error("other"))).toBe(false);
        expect(isLoginRequiredError(null)).toBe(false);
    });
});

describe("errorCodeOf", () => {
    it("extracts string codes and ignores the rest", () => {
        expect(errorCodeOf(new CodedError("x", "login_required"))).toBe("login_required");
        expect(errorCodeOf(new Error("x"))).toBeUndefined();
        expect(errorCodeOf(undefined)).toBeUndefined();
    });
});
