import { describe, expect, test } from "bun:test";
import { isSecretPath, isSecureRef, secureRef } from "./SecureRef";

describe("secureRef", () => {
    test("accepts canonical vault paths", () => {
        expect(secureRef("ai/acc_xai_key/apiKey")).toEqual({ type: "secure", path: "ai/acc_xai_key/apiKey" });
        expect(secureRef("ai/acc_max/secondary.accessToken").path).toBe("ai/acc_max/secondary.accessToken");
        expect(secureRef("ai-proxy/clients/eve").path).toBe("ai-proxy/clients/eve");
    });

    test("rejects malformed paths", () => {
        for (const bad of ["", "noSlash", "../etc/passwd", "ai//x", "/ai/x", "ai/", "AI/x"]) {
            expect(() => secureRef(bad)).toThrow();
            expect(isSecretPath(bad)).toBe(false);
        }
    });
});

describe("isSecureRef", () => {
    test("recognises well-formed refs", () => {
        expect(isSecureRef({ type: "secure", path: "ai/acc/apiKey" })).toBe(true);
    });

    test("rejects everything else", () => {
        expect(isSecureRef({ type: "secure" })).toBe(false);
        expect(isSecureRef({ type: "plain", path: "ai/acc/apiKey" })).toBe(false);
        expect(isSecureRef({ type: "secure", path: "bad path" })).toBe(false);
        expect(isSecureRef("ai/acc/apiKey")).toBe(false);
        expect(isSecureRef(null)).toBe(false);
        expect(isSecureRef(undefined)).toBe(false);
    });
});
