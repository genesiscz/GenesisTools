import { describe, expect, test } from "bun:test";
import { buildTextPayload, buildWifiPayload, escapeWifiField, normalizeSecurity } from "./lib/payload";

describe("buildTextPayload", () => {
    test("passes URLs through verbatim", () => {
        expect(buildTextPayload("https://x.test?a=1&b=2")).toBe("https://x.test?a=1&b=2");
    });

    test("passes arbitrary text through unchanged", () => {
        expect(buildTextPayload("Hello, world")).toBe("Hello, world");
    });

    test("does not auto-prefix a scheme", () => {
        expect(buildTextPayload("example.com")).toBe("example.com");
    });

    test("preserves the empty string", () => {
        expect(buildTextPayload("")).toBe("");
    });
});

describe("escapeWifiField", () => {
    test("escapes each of the five reserved characters", () => {
        expect(escapeWifiField(";")).toBe("\\;");
        expect(escapeWifiField(",")).toBe("\\,");
        expect(escapeWifiField(":")).toBe("\\:");
        expect(escapeWifiField('"')).toBe('\\"');
        expect(escapeWifiField("\\")).toBe("\\\\");
    });

    test("escapes the backslash first so it is not double-processed", () => {
        // Input \; must become \\\; (backslash escaped, then the semicolon
        // escaped), NOT \\\\; (which would happen if ; were escaped first and
        // its new backslash then re-escaped).
        expect(escapeWifiField("\\;")).toBe("\\\\\\;");
    });

    test("leaves unreserved characters untouched", () => {
        expect(escapeWifiField("Plain Text 123")).toBe("Plain Text 123");
    });
});

describe("buildWifiPayload", () => {
    test("builds a plain WPA payload", () => {
        expect(buildWifiPayload({ ssid: "Foo", password: "bar", security: "WPA", hidden: false })).toBe(
            "WIFI:T:WPA;S:Foo;P:bar;H:false;;"
        );
    });

    test("escapes all reserved chars in ssid and password", () => {
        expect(buildWifiPayload({ ssid: 'a;b,c:d\\e"f', password: "x", security: "WPA", hidden: false })).toBe(
            'WIFI:T:WPA;S:a\\;b\\,c\\:d\\\\e\\"f;P:x;H:false;;'
        );
    });

    test("nopass emits an empty P field and ignores the password", () => {
        expect(buildWifiPayload({ ssid: "Foo", security: "nopass", hidden: false })).toBe(
            "WIFI:T:nopass;S:Foo;P:;H:false;;"
        );
        expect(buildWifiPayload({ ssid: "Foo", password: "ignored", security: "nopass", hidden: false })).toBe(
            "WIFI:T:nopass;S:Foo;P:;H:false;;"
        );
    });

    test("--hidden flips H to true; default is false", () => {
        expect(buildWifiPayload({ ssid: "Foo", password: "bar", security: "WPA", hidden: true })).toBe(
            "WIFI:T:WPA;S:Foo;P:bar;H:true;;"
        );
        expect(buildWifiPayload({ ssid: "Foo", password: "bar", security: "WPA", hidden: false })).toBe(
            "WIFI:T:WPA;S:Foo;P:bar;H:false;;"
        );
    });

    test("WEP security is carried into the T field", () => {
        expect(buildWifiPayload({ ssid: "HiddenNet", password: "secret", security: "WEP", hidden: true })).toBe(
            "WIFI:T:WEP;S:HiddenNet;P:secret;H:true;;"
        );
    });

    test("missing password on a non-nopass network yields an empty P (caller enforces requiredness)", () => {
        expect(buildWifiPayload({ ssid: "Foo", security: "WPA", hidden: false })).toBe("WIFI:T:WPA;S:Foo;P:;H:false;;");
    });
});

describe("normalizeSecurity", () => {
    test("accepts canonical casing", () => {
        expect(normalizeSecurity("WPA")).toBe("WPA");
        expect(normalizeSecurity("WEP")).toBe("WEP");
        expect(normalizeSecurity("nopass")).toBe("nopass");
    });

    test("normalizes case-insensitive input to canonical casing", () => {
        expect(normalizeSecurity("wpa")).toBe("WPA");
        expect(normalizeSecurity("Wep")).toBe("WEP");
        expect(normalizeSecurity("NOPASS")).toBe("nopass");
    });

    test("throws on an unknown security type", () => {
        expect(() => normalizeSecurity("bogus")).toThrow(/Invalid --security/);
        expect(() => normalizeSecurity("")).toThrow(/Invalid --security/);
    });
});
