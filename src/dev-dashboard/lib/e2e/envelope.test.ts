import { describe, expect, it } from "bun:test";
import { decodeEnvelope, type E2eEnvelope, encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";

describe("E2eEnvelope codec", () => {
    it("round-trips", () => {
        const env: E2eEnvelope = { v: 1, epk: "a", n: "b", ct: "c" };

        expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
    });

    it("throws on a bad version", () => {
        expect(() => decodeEnvelope('{"v":2,"epk":"a","n":"b","ct":"c"}')).toThrow(/invalid/);
    });

    it("throws on a missing field", () => {
        expect(() => decodeEnvelope('{"v":1,"epk":"a","n":"b"}')).toThrow(/invalid/);
    });

    it("throws on malformed JSON", () => {
        expect(() => decodeEnvelope("not json")).toThrow();
    });
});
