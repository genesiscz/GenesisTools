import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "./constants.ts";
import { redactMcpValue, safeTokenErrorCode } from "./redact.ts";

describe("redactMcpValue", () => {
    test("redacts Authorization and the gateway header, leaves url", () => {
        const redacted = redactMcpValue({
            url: "http://127.0.0.1:8318/mcp/rohlik",
            headers: {
                Authorization: "Bearer secret-access",
                [GATEWAY_HEADER]: "local-token",
            },
        });

        expect(redacted.url).toBe("http://127.0.0.1:8318/mcp/rohlik");
        expect(redacted.headers.Authorization).toBe("•••");
        expect(redacted.headers[GATEWAY_HEADER]).toBe("•••");
    });
});

describe("safeTokenErrorCode", () => {
    test("passes a registered OAuth error code through", () => {
        expect(safeTokenErrorCode("invalid_grant", 400)).toBe("invalid_grant");
        expect(safeTokenErrorCode("invalid_client", 401)).toBe("invalid_client");
    });

    test("an unregistered value collapses to the status, never to provider text", () => {
        const leak = "Bearer figu_live_2b8d1c0e authorized for martin@example.com";

        expect(safeTokenErrorCode(leak, 500)).toBe("HTTP 500");
        expect(safeTokenErrorCode(leak, 500)).not.toContain("figu_");
    });

    test("a missing or non-string error is the status", () => {
        expect(safeTokenErrorCode(undefined, 503)).toBe("HTTP 503");
        expect(safeTokenErrorCode({ nested: "object" }, 418)).toBe("HTTP 418");
    });
});
