import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "./constants.ts";
import { redactMcpValue } from "./redact.ts";

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
