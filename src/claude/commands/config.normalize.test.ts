import { describe, expect, test } from "bun:test";
import { normalizeAuthorizationCode } from "./config";

describe("normalizeAuthorizationCode", () => {
    test("a bare code passes through", () => {
        expect(normalizeAuthorizationCode("abc123#state456")).toEqual({ code: "abc123#state456" });
    });

    test("surrounding whitespace is trimmed", () => {
        expect(normalizeAuthorizationCode("  abc123#state456  ")).toEqual({ code: "abc123#state456" });
    });

    test("the callback URL yields code#state", () => {
        const result = normalizeAuthorizationCode(
            "https://platform.claude.com/oauth/code/callback?code=THECODE&state=THESTATE"
        );
        expect(result).toEqual({ code: "THECODE#THESTATE" });
    });

    test("a callback URL without state yields the bare code", () => {
        expect(normalizeAuthorizationCode("https://platform.claude.com/oauth/code/callback?code=ONLYCODE")).toEqual({
            code: "ONLYCODE",
        });
    });

    test("the AUTHORIZE url is rejected with guidance", () => {
        const result = normalizeAuthorizationCode(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=x&scope=user%3Ainference"
        );
        expect(result).toHaveProperty("error");
        expect("error" in result && result.error).toContain("authorization URL");
    });

    test("a URL with no code parameter is rejected", () => {
        const result = normalizeAuthorizationCode("https://example.com/callback?foo=bar");
        expect(result).toHaveProperty("error");
    });

    test("an unparseable http string is rejected", () => {
        const result = normalizeAuthorizationCode("http://");
        expect(result).toHaveProperty("error");
    });

    test("non-URL junk is passed through as a code (the server rejects it)", () => {
        expect(normalizeAuthorizationCode("not a url at all")).toEqual({ code: "not a url at all" });
    });
});
