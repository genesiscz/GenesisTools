import { describe, expect, test } from "bun:test";
import { cleanPromptText, cleanTranscriptText } from "./clean-text";

describe("cleanTranscriptText", () => {
    test("a slash-command body becomes /name", () => {
        const raw =
            "<command-message>\n<command-name>speckit.implement</command-name>\n" +
            "<command-args></command-args>\n</command-message>";
        expect(cleanTranscriptText(raw)).toBe("/speckit.implement");
    });

    test("strips [Image #N] placeholders", () => {
        expect(cleanTranscriptText("[Image #1] fix the login")).toBe("fix the login");
    });

    test("slashFallback false leaves a command-only body empty", () => {
        expect(cleanTranscriptText("<command-name>/rename</command-name>", { slashFallback: false })).toBe("");
    });
});

describe("cleanPromptText", () => {
    test("keeps ordinary prompt text unchanged", () => {
        expect(cleanPromptText("fix the auth callback")).toBe("fix the auth callback");
    });

    test("a prompt that is only noise yields null", () => {
        expect(cleanPromptText("<system-reminder>background context</system-reminder>")).toBeNull();
        expect(cleanPromptText("   ")).toBeNull();
        expect(cleanPromptText(null)).toBeNull();
    });
});
