import { describe, expect, test } from "bun:test";
import { formatWarmupViaHint } from "./service";

describe("formatWarmupViaHint", () => {
    test("oauth and missing via print nothing", () => {
        expect(formatWarmupViaHint()).toBe("");
        expect(formatWarmupViaHint("oauth")).toBe("");
    });

    test("login-long is named in the user-facing suffix", () => {
        expect(formatWarmupViaHint("login-long")).toBe(" used login-long token");
    });
});
