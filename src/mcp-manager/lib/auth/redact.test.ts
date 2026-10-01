import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "./constants.ts";
import { redactConfigText, redactMcpValue, safeTokenErrorCode } from "./redact.ts";

describe("redactConfigText", () => {
    test("an escaped quote, a TOML literal string and an AUTH_CONFIG name leave no part of the secret", () => {
        const json = '{"env": {"DB_PASSWORD": "prefix\\"remaining-secret", "LOG_LEVEL": "debug"}}';
        const toml = "Authorization = 'Bearer invented-token'\nDOCKER_AUTH_CONFIG = \"invented-auth\"\nname = 'keep'";

        expect(redactConfigText(json)).not.toContain("remaining-secret");
        expect(redactConfigText(json)).toContain('"LOG_LEVEL": "debug"');
        expect(redactConfigText(toml)).not.toContain("invented-token");
        expect(redactConfigText(toml)).not.toContain("invented-auth");
        expect(redactConfigText(toml)).toContain("name = 'keep'");
    });

    test("hides gateway and authorization header values in JSON and TOML, keeps everything else", () => {
        const json = `{"headers": {"${GATEWAY_HEADER}": "local-token", "Authorization": "Bearer s3", "X-Other": "keep"}}`;
        const toml = `[mcp_servers.x.http_headers]\n${GATEWAY_HEADER} = "local-token"\nurl = "http://127.0.0.1:8318/mcp/x"`;

        const redactedJson = redactConfigText(json);
        const redactedToml = redactConfigText(toml);

        expect(redactedJson).not.toContain("local-token");
        expect(redactedJson).not.toContain("s3");
        expect(redactedJson).toContain('"X-Other": "keep"');
        expect(redactedToml).not.toContain("local-token");
        expect(redactedToml).toContain('url = "http://127.0.0.1:8318/mcp/x"');
    });

    test("hides secret-looking env values, keeps ordinary env", () => {
        const json = `"env": {"OPENAI_API_KEY": "sk-invented", "SHOP_TOKEN": "t-invented", "LOG_LEVEL": "debug"}`;
        const redacted = redactConfigText(json);

        expect(redacted).not.toContain("sk-invented");
        expect(redacted).not.toContain("t-invented");
        expect(redacted).toContain('"LOG_LEVEL": "debug"');
    });
});

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

describe("redactConfigText TOML multiline strings", () => {
    test("redacts a triple-quoted value in full, in both quote forms, and leaves the next key alone", () => {
        const toml =
            'PRIVATE_KEY = """\ninvented-secret\n"""\nNAME = "kept"\nAPI_TOKEN = \'\'\'\nabc-invented\n\'\'\'\n';
        const out = redactConfigText(toml);

        expect(out).not.toContain("invented-secret");
        expect(out).not.toContain("abc-invented");
        expect(out).toContain('NAME = "kept"');
    });
});
