import { describe, expect, test } from "bun:test";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { parseFileDiff } from "./file-diff";

function sides(path: string, oldPath: string | null = null) {
    return { path, oldPath, oldContents: "{\n}\n", newContents: '{\n  "a": 1\n}\n', key: path };
}

describe("parseFileDiff", () => {
    test("a plain ASCII path keeps its name", () => {
        const fileDiff = parseFileDiff(sides("notes/data/Enums.json"));

        expect(fileDiff.name).toBe("notes/data/Enums.json");
        expect(fileDiff.prevName).toBeUndefined();
    });

    test("a non-ASCII path keeps its name, not git's C-quoted form", () => {
        const fileDiff = parseFileDiff(sides("Ďábel/ČŘ/data/Enums.json"));

        expect(fileDiff.name).toBe("Ďábel/ČŘ/data/Enums.json");
        expect(getFiletypeFromFileName(fileDiff.name)).toBe("json");
    });

    test("a path with a double quote, a backslash and a space keeps its name", () => {
        const path = 'odd "name"\\with space.md';

        expect(parseFileDiff(sides(path)).name).toBe(path);
    });

    test("a renamed non-ASCII path keeps both names", () => {
        const fileDiff = parseFileDiff(sides("Nový/Č.md", "Starý/Č.md"));

        expect(fileDiff.name).toBe("Nový/Č.md");
        expect(fileDiff.prevName).toBe("Starý/Č.md");
        expect(fileDiff.type).toBe("rename-changed");
    });

    test("a new non-ASCII file is new and has no previous name", () => {
        const fileDiff = parseFileDiff({ ...sides("Ďábel/nový.md"), oldContents: null });

        expect(fileDiff.name).toBe("Ďábel/nový.md");
        expect(fileDiff.prevName).toBeUndefined();
        expect(fileDiff.type).toBe("new");
    });
});
