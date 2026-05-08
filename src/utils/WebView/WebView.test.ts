import { describe, expect, it } from "bun:test";
import { WebViewError, WebViewEvaluateError, WebViewNavigationError, WebViewTimeoutError } from "./errors";

describe("WebViewError", () => {
    it("sets name, message, instanceId", () => {
        const err = new WebViewError("test message", "abc123");
        expect(err.name).toBe("WebViewError");
        expect(err.message).toBe("test message");
        expect(err.instanceId).toBe("abc123");
        expect(err instanceof Error).toBe(true);
    });
});

describe("WebViewNavigationError", () => {
    it("includes url and cause in message", () => {
        const cause = new Error("DNS lookup failed");
        const err = new WebViewNavigationError("https://example.com", "id1", cause);
        expect(err.name).toBe("WebViewNavigationError");
        expect(err.url).toBe("https://example.com");
        expect(err.cause).toBe(cause);
        expect(err.message).toContain("https://example.com");
        expect(err.message).toContain("DNS lookup failed");
    });
});

describe("WebViewTimeoutError", () => {
    it("includes operation and timeoutMs", () => {
        const err = new WebViewTimeoutError("navigate(https://foo.com)", 30000, "id2");
        expect(err.name).toBe("WebViewTimeoutError");
        expect(err.operation).toBe("navigate(https://foo.com)");
        expect(err.timeoutMs).toBe(30000);
        expect(err.message).toContain("30000ms");
    });
});

describe("WebViewEvaluateError", () => {
    it("includes expression and cause", () => {
        const err = new WebViewEvaluateError("document.title", "id3", "TypeError: Cannot read");
        expect(err.name).toBe("WebViewEvaluateError");
        expect(err.expression).toBe("document.title");
        expect(err.message).toContain("TypeError: Cannot read");
    });
});
