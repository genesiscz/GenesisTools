import { describe, expect, test } from "bun:test";
import {
    buildObsidianNoteRelativePath,
    normalizeObsidianBaseName,
    obsidianNoteFileName,
} from "@app/utils/obsidian/filename";

describe("obsidian filename", () => {
    test("normalizeObsidianBaseName strips a single .md suffix", () => {
        expect(normalizeObsidianBaseName("note.md")).toBe("note");
        expect(normalizeObsidianBaseName("note.MD")).toBe("note");
        expect(normalizeObsidianBaseName("  note.md  ")).toBe("note");
    });

    test("obsidianNoteFileName never doubles .md", () => {
        expect(obsidianNoteFileName("tools-task.md")).toBe("tools-task.md");
        expect(obsidianNoteFileName("tools-task")).toBe("tools-task.md");
    });

    test("buildObsidianNoteRelativePath", () => {
        expect(buildObsidianNoteRelativePath("inbox/qa-test", "foo.md")).toBe("inbox/qa-test/foo.md");
    });
});
