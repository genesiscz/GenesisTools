import type { VaultEntry } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { filterVaultEntries } from "@/features/obsidian/vault-filter";

const tree: VaultEntry[] = [
    {
        name: "Acme",
        relativePath: "Acme",
        isDirectory: true,
        children: [
            { name: "Analysis.md", relativePath: "Acme/Analysis.md", isDirectory: false },
            { name: "Notes.md", relativePath: "Acme/Notes.md", isDirectory: false },
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
        expect(out[0].name).toBe("Acme");
        expect(out[0].children).toHaveLength(1);
        expect(out[0].children?.[0].name).toBe("Analysis.md");
    });

    it("keeps a folder when the folder name itself matches (children FILTERED — web parity)", () => {
        // EXACT parity with the web `filterEntries`: a folder-name match returns the folder with its
        // *filtered* children. Since neither child matches "acme", children is empty.
        const out = filterVaultEntries(tree, "acme");
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe("Acme");
        expect(out[0].children).toHaveLength(0);
    });

    it("matches a top-level file", () => {
        const out = filterVaultEntries(tree, "readme");
        expect(out.map((e) => e.name)).toEqual(["README.md"]);
    });

    it("drops everything when nothing matches", () => {
        expect(filterVaultEntries(tree, "zzz")).toEqual([]);
    });

    // Regression test: mac.foltyn.dev/obsidian search — a vault-relative path must show that note
    it("shows the note named by a folder/file path and hides its siblings", () => {
        const nested: VaultEntry[] = [
            {
                name: "abc-123456-pr-1234-billing-snapshots",
                relativePath: "abc-123456-pr-1234-billing-snapshots",
                isDirectory: true,
                children: [
                    {
                        name: "ADO-123456-title-description.md",
                        relativePath: "abc-123456-pr-1234-billing-snapshots/ADO-123456-title-description.md",
                        isDirectory: false,
                    },
                    {
                        name: "other.md",
                        relativePath: "abc-123456-pr-1234-billing-snapshots/other.md",
                        isDirectory: false,
                    },
                ],
            },
        ];

        const fullPath = "abc-123456-pr-1234-billing-snapshots/ADO-123456-title-description.md";
        const out = filterVaultEntries(nested, fullPath);
        const partial = filterVaultEntries(nested, "billing-snapshots/ADO-123456");

        expect(out).toHaveLength(1);
        expect(out[0]?.children?.map((entry) => entry.name)).toEqual(["ADO-123456-title-description.md"]);
        expect(partial[0]?.children?.map((entry) => entry.name)).toEqual(["ADO-123456-title-description.md"]);
    });
});
