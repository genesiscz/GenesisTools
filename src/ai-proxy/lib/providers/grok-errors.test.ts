import { describe, expect, it } from "bun:test";
import { mapGrokError } from "@app/ai-proxy/lib/providers/grok-errors";

describe("mapGrokError", () => {
    it("re-wraps Grok's string-error shape into the OpenAI envelope", () => {
        // Actual body captured from the grok chat proxy when a client sent
        // "data:image/jpeg;base64,[object Object]" (ai@7 + @ai-sdk/openai v2 compat).
        const envelope = mapGrokError({
            status: 400,
            bodyText: '{"code":"invalid-argument","error":"Base64 string of provided image cannot be decoded."}',
        });

        expect(envelope.error.message).toBe("Base64 string of provided image cannot be decoded.");
        expect(envelope.error.type).toBe("invalid_request_error");
        expect(envelope.error.code).toBe("invalid-argument");
    });

    it("passes through an already OpenAI-shaped error", () => {
        const envelope = mapGrokError({
            status: 400,
            bodyText: '{"error":{"message":"bad tool call","type":"invalid_request_error","code":"tool_error"}}',
        });

        expect(envelope.error.message).toBe("bad tool call");
        expect(envelope.error.type).toBe("invalid_request_error");
        expect(envelope.error.code).toBe("tool_error");
    });

    it("uses raw text for non-JSON bodies", () => {
        const envelope = mapGrokError({ status: 502, bodyText: "upstream exploded" });

        expect(envelope.error.message).toBe("upstream exploded");
        expect(envelope.error.type).toBe("upstream_error");
    });

    it("falls back to a status message for empty bodies", () => {
        const envelope = mapGrokError({ status: 500, bodyText: "" });

        expect(envelope.error.message).toBe("Grok upstream returned 500");
        expect(envelope.error.type).toBe("upstream_error");
    });

    it("maps 429 to rate_limit_error with a retry hint", () => {
        const envelope = mapGrokError({
            status: 429,
            bodyText: '{"code":"resource-exhausted","error":"Too many requests."}',
            retryAfterSec: 30,
        });

        expect(envelope.error.message).toBe("Too many requests. Retry after 30s.");
        expect(envelope.error.type).toBe("rate_limit_error");
        expect(envelope.error.code).toBe("resource-exhausted");
    });
});
