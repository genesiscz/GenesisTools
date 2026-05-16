import { describe, expect, test } from "bun:test";
import { createBasicAuthCredentials, makeBasicAuthHeader, verifyBasicAuthHeader } from "@app/dev-dashboard/lib/auth";

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
