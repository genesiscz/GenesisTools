import { describe, expect, it } from "bun:test";
import { cleanRepetitions } from "@app/utils/ai/transcription/repetition-cleanup";

describe("two-level cleanup idempotency", () => {
    it("manager-clean then stitched-clean equals single clean (no double-collapse drift)", () => {
        const looped = { text: "a a a a a a b a a a a a a c" };
        const managerPass = cleanRepetitions(looped); // per-chunk / single-shot
        const stitchedPass = cleanRepetitions(managerPass); // Transcriber stitched
        expect(stitchedPass).toEqual(managerPass);
        expect(managerPass.text).toBe("a b a c");
    });
});
