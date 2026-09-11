import { describe, expect, it } from "bun:test";
import { injectBytes, injectScroll, injectScrollPage, parseBridgeMsg } from "@/features/terminals/bridge";

describe("bridge — RN→WebView injectors", () => {
    it("injectBytes wraps a base64 chunk in a synthetic message event", () => {
        const js = injectBytes("aGVsbG8=");

        expect(js).toContain('new MessageEvent("message"');
        expect(js).toContain('"aGVsbG8="');
        expect(js.endsWith("true;")).toBe(true);
    });

    it("injectBytes JSON-escapes the payload (no raw breakout)", () => {
        const js = injectBytes('a"b');

        // The quote must be escaped inside the JS string literal, not terminate it.
        expect(js).toContain('"a\\"b"');
    });

    it("injectScroll truncates to an integer line count", () => {
        expect(injectScroll(3.9)).toContain("__ddScroll(3)");
        expect(injectScroll(-2.1)).toContain("__ddScroll(-2)");
    });

    it("injectScrollPage emits the direction literal", () => {
        expect(injectScrollPage(-1)).toContain("__ddScrollPage(-1)");
        expect(injectScrollPage(1)).toContain("__ddScrollPage(1)");
    });
});

describe("bridge — WebView→RN parser", () => {
    it("parses a well-formed data message", () => {
        const msg = parseBridgeMsg('{"t":"data","payload":"YWJj"}');

        expect(msg?.t).toBe("data");
        expect(msg?.payload).toBe("YWJj");
    });

    it("parses a resize message with dimensions", () => {
        const msg = parseBridgeMsg('{"t":"resize","cols":80,"rows":24}');

        expect(msg?.cols).toBe(80);
        expect(msg?.rows).toBe(24);
    });

    it("returns null for malformed JSON", () => {
        expect(parseBridgeMsg("not json")).toBeNull();
    });

    it("returns null when the discriminant `t` is missing", () => {
        expect(parseBridgeMsg('{"payload":"x"}')).toBeNull();
    });
});
