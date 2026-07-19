import { describe, expect, it } from "bun:test";
import { mapWhamError, parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";

describe("mapWhamError", () => {
    it("maps 401 to an actionable authentication_error", () => {
        const envelope = mapWhamError({ status: 401, bodyText: '{"detail":"Unauthorized"}' });

        expect(envelope.error.type).toBe("authentication_error");
        expect(envelope.error.code).toBe("codex_auth_expired");
        expect(envelope.error.message).toContain("accounts login codex");
    });

    it("maps 429 with a retry hint", () => {
        const envelope = mapWhamError({
            status: 429,
            bodyText: '{"error":{"message":"Too many requests","code":"rate_limit"}}',
            retryAfterSec: 30,
        });

        expect(envelope.error.type).toBe("rate_limit_error");
        expect(envelope.error.code).toBe("rate_limit");
        expect(envelope.error.message).toContain("Too many requests");
        expect(envelope.error.message).toContain("Retry after 30s");
    });

    it("keeps the upstream message for 400s and tolerates non-JSON bodies", () => {
        const bad = mapWhamError({
            status: 400,
            bodyText: '{"error":{"message":"Unsupported parameter: max_output_tokens","type":"invalid_request_error"}}',
        });
        expect(bad.error.message).toBe("Unsupported parameter: max_output_tokens");
        expect(bad.error.type).toBe("invalid_request_error");

        const html = mapWhamError({ status: 502, bodyText: "<html>bad gateway</html>" });
        expect(html.error.type).toBe("upstream_error");
        expect(html.error.message).toBe("ChatGPT upstream returned 502");
    });
});

describe("parseRetryAfterSeconds", () => {
    it("parses numeric Retry-After", () => {
        expect(parseRetryAfterSeconds(new Headers({ "retry-after": "42" }))).toBe(42);
    });

    it("returns undefined when absent or garbage", () => {
        expect(parseRetryAfterSeconds(new Headers())).toBeUndefined();
        expect(parseRetryAfterSeconds(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    });
});
