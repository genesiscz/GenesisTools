import { describe, expect, test } from "bun:test";
import { classifyRefreshError, classifyRefreshResponse } from "./refresh-failure.ts";
import { OutboundUrlPolicyError } from "./url-policy.ts";

function coded(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

describe("classifyRefreshError: no answer from the token endpoint is not a dead login", () => {
    test.each([
        ["ENOTFOUND", coded("getaddrinfo ENOTFOUND identity.shop.example", "ENOTFOUND")],
        ["EAI_AGAIN", coded("getaddrinfo EAI_AGAIN identity.shop.example", "EAI_AGAIN")],
        ["ECONNREFUSED", coded("connect ECONNREFUSED 203.0.113.7:443", "ECONNREFUSED")],
        ["ETIMEDOUT", coded("connect ETIMEDOUT 203.0.113.7:443", "ETIMEDOUT")],
        ["ENETUNREACH", coded("connect ENETUNREACH 203.0.113.7:443", "ENETUNREACH")],
        ["ConnectionRefused", coded("Unable to connect. Is the computer able to access the url?", "ConnectionRefused")],
    ])("%s is retry-later", (reason, error) => {
        expect(classifyRefreshError(error)).toEqual({ kind: "retry-later", reason });
    });

    test("the policy error that wraps a DNS failure keeps the code from its text", () => {
        const error = new OutboundUrlPolicyError(
            "https://identity.shop.example/oauth2/token",
            "DNS resolution failed: getaddrinfo ENOTFOUND"
        );

        expect(classifyRefreshError(error)).toEqual({ kind: "retry-later", reason: "ENOTFOUND" });
    });

    test("a DNS answer with no addresses is retry-later", () => {
        const error = new OutboundUrlPolicyError(
            "https://identity.shop.example/token",
            "DNS resolution returned no addresses"
        );

        expect(classifyRefreshError(error)).toEqual({ kind: "retry-later", reason: "DNS resolution failed" });
    });

    test("a deadline abort is retry-later, also when it is the cause of an AbortError", () => {
        const timeout = new DOMException("The operation timed out.", "TimeoutError");
        const aborted = Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
            cause: timeout,
        });

        expect(classifyRefreshError(timeout)).toEqual({ kind: "retry-later", reason: "timed out" });
        expect(classifyRefreshError(aborted)).toEqual({ kind: "retry-later", reason: "timed out" });
    });

    test("a policy refusal that is not DNS still asks for a login", () => {
        const error = new OutboundUrlPolicyError(
            "https://identity.shop.example/token",
            "identity.shop.example resolves to the private address 10.0.0.5, and https://mcp.shop.example is public"
        );

        expect(classifyRefreshError(error)).toEqual({ kind: "login" });
    });

    test("an unrelated error, a non-object and an error-code word in plain text ask for a login", () => {
        expect(classifyRefreshError(new Error("Response exceeds the MCP auth response limit."))).toEqual({
            kind: "login",
        });
        expect(classifyRefreshError("ENOTFOUND")).toEqual({ kind: "login" });
        expect(classifyRefreshError(new Error("upstream said ENOTFOUND"))).toEqual({ kind: "login" });
    });
});

describe("classifyRefreshResponse: only a refusal of the grant asks for a login", () => {
    test.each([
        [400, "invalid_grant"],
        [400, "invalid_client"],
        [401, "HTTP 401"],
        [403, "HTTP 403"],
        [307, "HTTP 307"],
    ])("%i %s asks for a login", (status, code) => {
        expect(classifyRefreshResponse(status, code)).toEqual({ kind: "login" });
    });

    test.each([
        [500, "HTTP 500"],
        [503, "HTTP 503"],
        [429, "HTTP 429"],
        [400, "temporarily_unavailable"],
        [400, "server_error"],
    ])("%i %s is retry-later", (status, code) => {
        expect(classifyRefreshResponse(status, code)).toEqual({ kind: "retry-later", reason: code });
    });
});
