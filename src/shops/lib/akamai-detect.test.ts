import { describe, expect, it } from "bun:test";
import { classifyAkamaiSignals, extractAbckCookie, isAkamaiBlock } from "./akamai-detect";

describe("isAkamaiBlock", () => {
    it("returns true on status 403", () => {
        expect(isAkamaiBlock({ status: 403, body: "", setCookie: [] })).toBe(true);
    });

    it("returns true on status 429", () => {
        expect(isAkamaiBlock({ status: 429, body: "", setCookie: [] })).toBe(true);
    });

    it("returns true on status 503", () => {
        expect(isAkamaiBlock({ status: 503, body: "", setCookie: [] })).toBe(true);
    });

    it("returns true if body contains sec-if-cpt-container", () => {
        expect(
            isAkamaiBlock({
                status: 200,
                body: '<div id="sec-if-cpt-container"></div>',
                setCookie: [],
            })
        ).toBe(true);
    });

    it("returns true if body contains 'Reference #' followed by hex", () => {
        expect(
            isAkamaiBlock({
                status: 403,
                body: "<p>Reference #18.9c17655f.1778241364.1bdabaec</p>",
                setCookie: [],
            })
        ).toBe(true);
    });

    it("returns true even for status 200 if Reference # marker is present", () => {
        expect(
            isAkamaiBlock({
                status: 200,
                body: "Reference #abc.123",
                setCookie: [],
            })
        ).toBe(true);
    });

    it("returns false on plain 200 with normal HTML", () => {
        expect(
            isAkamaiBlock({
                status: 200,
                body: "<html><body><h1>Tesco</h1></body></html>",
                setCookie: ["_abck=ABCDEF; path=/"],
            })
        ).toBe(false);
    });

    it("ignores _abck cookie alone", () => {
        expect(
            isAkamaiBlock({
                status: 200,
                body: "<html>Bread products...</html>",
                setCookie: ["_abck=longvalue; path=/", "another=x"],
            })
        ).toBe(false);
    });
});

describe("classifyAkamaiSignals", () => {
    it("returns the list of triggering signals when blocked", () => {
        const signals = classifyAkamaiSignals({
            status: 403,
            body: '<div id="sec-if-cpt-container">x</div>Reference #abc.def',
            setCookie: ["_abck=x"],
        });
        expect(signals).toContain("status:403");
        expect(signals).toContain("body:sec-if-cpt-container");
        expect(signals).toContain("body:reference-id");
        expect(signals).not.toContain("setcookie:_abck");
    });

    it("returns [] for clean responses", () => {
        const signals = classifyAkamaiSignals({
            status: 200,
            body: "<html>OK</html>",
            setCookie: [],
        });
        expect(signals).toEqual([]);
    });
});

describe("extractAbckCookie", () => {
    it("returns the trimmed _abck value from a Set-Cookie array", () => {
        const v = extractAbckCookie([
            "session=foo; Path=/",
            "_abck=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_*~; Path=/; HttpOnly",
            "tracking=bar",
        ]);
        expect(v).toContain("ABCDEFG");
        expect(v).not.toBeNull();
        expect(v!.length).toBeLessThanOrEqual(80);
    });

    it("returns null when no _abck cookie is present", () => {
        expect(extractAbckCookie(["session=foo"])).toBeNull();
    });
});
