import { describe, expect, it } from "bun:test";
import {
    expandedDirsForFolderToggle,
    expandedDirsForNote,
    parseOpenDirs,
    serializeOpenDirs,
} from "@/features/obsidian/expanded-dirs";

describe("parseOpenDirs / serializeOpenDirs", () => {
    it("round-trips a comma-joined set", () => {
        const set = parseOpenDirs("a,a/b,c");
        expect([...set].sort()).toEqual(["a", "a/b", "c"]);
        expect(serializeOpenDirs(set).split(",").sort()).toEqual(["a", "a/b", "c"]);
    });

    it("parses undefined/empty as an empty set", () => {
        expect(parseOpenDirs(undefined).size).toBe(0);
        expect(parseOpenDirs("").size).toBe(0);
        expect(serializeOpenDirs(new Set())).toBe("");
    });
});

describe("expandedDirsForNote", () => {
    it("adds every ancestor folder of the note path", () => {
        const next = expandedDirsForNote("Acme/bun/Analysis.md", parseOpenDirs("other"));
        expect([...next].sort()).toEqual(["other", "Acme", "Acme/bun"].sort());
    });

    it("a top-level note adds no folders", () => {
        expect(expandedDirsForNote("README.md", new Set()).size).toBe(0);
    });
});

describe("expandedDirsForFolderToggle", () => {
    it("adds on expand and removes on collapse", () => {
        const opened = expandedDirsForFolderToggle("Acme", true, new Set());
        expect(opened.has("Acme")).toBe(true);
        const closed = expandedDirsForFolderToggle("Acme", false, opened);
        expect(closed.has("Acme")).toBe(false);
    });
});
