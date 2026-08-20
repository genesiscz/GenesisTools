import { decodeEnvelope, encodeEnvelope } from "@/transport/e2e/envelope";
import { describe, expect, it } from "bun:test";

describe("E2eEnvelope codec (mobile re-export from @dd/contract)", () => {
    it("round-trips", () => {
        const env = { v: 1 as const, epk: "a", n: "b", ct: "c" };
        expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
    });

    it("throws on a bad version", () => {
        expect(() => decodeEnvelope('{"v":2,"epk":"a","n":"b","ct":"c"}')).toThrow(/invalid/);
    });
});
