import { describe, expect, test } from "bun:test";
import { cleanPromptText, cleanTranscriptText, isBareSlashCommandText } from "./clean-text";

describe("cleanTranscriptText", () => {
    test("a slash command with arguments becomes /name plus those arguments", () => {
        const raw =
            "<command-message>\n<command-name>speckit.implement</command-name>\n" +
            "<command-args>the login screen</command-args>\n</command-message>";
        expect(cleanTranscriptText(raw)).toBe("/speckit.implement the login screen");
    });

    test("a slash command with no arguments leaves nothing", () => {
        const raw =
            "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n" +
            "<command-args></command-args>";
        expect(cleanTranscriptText(raw)).toBe("");
        expect(isBareSlashCommandText(raw)).toBe(true);
    });

    test("an argument-less command name with no args block is still bare", () => {
        expect(isBareSlashCommandText("<command-name>/compact</command-name>")).toBe(true);
    });

    test("ordinary prose is not a bare slash command", () => {
        expect(isBareSlashCommandText("fix the auth callback")).toBe(false);
        expect(isBareSlashCommandText("<command-name>/rename</command-name><command-args>x</command-args>")).toBe(
            false
        );
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
        expect(cleanPromptText("<command-name>/clear</command-name><command-args></command-args>")).toBeNull();
        expect(cleanPromptText("   ")).toBeNull();
        expect(cleanPromptText(null)).toBeNull();
    });
});
