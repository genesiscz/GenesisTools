import type { VaultEntry } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { filterVaultEntries } from "@/features/obsidian/vault-filter";

const tree: VaultEntry[] = [
    {
        name: "ČEZ",
        relativePath: "ČEZ",
        isDirectory: true,
        children: [
            { name: "Analysis.md", relativePath: "ČEZ/Analysis.md", isDirectory: false },
            { name: "Notes.md", relativePath: "ČEZ/Notes.md", isDirectory: false },
        ],
    },
    { name: "README.md", relativePath: "README.md", isDirectory: false },
];

describe("filterVaultEntries", () => {
    it("returns the input unchanged for an empty query", () => {
        expect(filterVaultEntries(tree, "")).toEqual(tree);
    });

    it("keeps a folder whose descendant matches, pruning non-matches", () => {
        const out = filterVaultEntries(tree, "analysis");
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("ČEZ");
        expect(out[0].children).toHaveLength(1);
        expect(out[0].children?.[0].name).toBe("Analysis.md");
    });

    it("keeps a folder when the folder name itself matches (children FILTERED — web parity)", () => {
        // EXACT parity with the web `filterEntries`: a folder-name match returns the folder with its
        // *filtered* children. Since neither child matches "čez", children is empty.
        const out = filterVaultEntries(tree, "čez");
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("ČEZ");
        expect(out[0].children).toHaveLength(0);
    });

    it("matches a top-level file", () => {
        const out = filterVaultEntries(tree, "readme");
        expect(out.map((e) => e.name)).toEqual(["README.md"]);
    });

    it("drops everything when nothing matches", () => {
        expect(filterVaultEntries(tree, "zzz")).toEqual([]);
    });
});
