import { describe, expect, test } from "bun:test";
import { hasValidLongLivedToken, LONG_TOKEN_MIN_LENGTH } from "./token-verify";

describe("hasValidLongLivedToken", () => {
    test("absent token is not valid", () => {
        expect(hasValidLongLivedToken({})).toBe(false);
    });

    test("a truncated paste is treated as absent", () => {
        expect(hasValidLongLivedToken({ longLivedToken: `sk-ant-oat01-${"x".repeat(40)}` })).toBe(false);
    });

    test("a full-length token is valid", () => {
        expect(hasValidLongLivedToken({ longLivedToken: "x".repeat(LONG_TOKEN_MIN_LENGTH) })).toBe(true);
    });
});
