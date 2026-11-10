import { describe, expect, test } from "bun:test";
import type { VaultEntry } from "@genesiscz/utils/obsidian/vault-tree";
import { resolveWikilinkToVaultPath } from "@genesiscz/utils/obsidian/wikilink-resolve";

const entries: VaultEntry[] = [
    {
        name: "GenesisTools",
        relativePath: "GenesisTools",
        isDirectory: true,
        children: [
            {
                name: "2026-05-17-TranscriptionFixes.md",
                relativePath: "GenesisTools/2026-05-17-TranscriptionFixes.md",
                isDirectory: false,
            },
            {
                name: "2026-05-17-TranscriptionFixes.verify.md",
                relativePath: "GenesisTools/2026-05-17-TranscriptionFixes.verify.md",
                isDirectory: false,
            },
        ],
    },
];

describe("resolveWikilinkToVaultPath", () => {
    test("resolves by basename", () => {
        expect(resolveWikilinkToVaultPath(entries, "2026-05-17-TranscriptionFixes")).toBe(
            "GenesisTools/2026-05-17-TranscriptionFixes.md"
        );
    });

    test("prefers same directory when multiple matches", () => {
        const dupes: VaultEntry[] = [
            {
                name: "a.md",
                relativePath: "other/a.md",
                isDirectory: false,
            },
            {
                name: "a.md",
                relativePath: "GenesisTools/a.md",
                isDirectory: false,
            },
        ];

        expect(resolveWikilinkToVaultPath(dupes, "a", "GenesisTools/from.md")).toBe("GenesisTools/a.md");
    });

    test("a composed link finds a decomposed file name and returns the name as the disk spells it", () => {
        // macOS keeps `á` of a file name as `a` + U+0301 (NFD); a link typed in a note is NFC.
        const disk = "Návrh.md".normalize("NFD");
        const nfd: VaultEntry[] = [
            { name: "Návrh.md".normalize("NFC"), relativePath: "Other/Návrh.md".normalize("NFC"), isDirectory: false },
            { name: disk, relativePath: `Notes/${disk}`, isDirectory: false },
        ];

        expect(resolveWikilinkToVaultPath(nfd.slice(1), "Návrh".normalize("NFC"))).toBe(`Notes/${disk}`);
        expect(resolveWikilinkToVaultPath(nfd.slice(1), "Notes/Návrh.md".normalize("NFC"))).toBe(`Notes/${disk}`);
        // Of two matches, the one in the linking note's folder still wins, whichever form either path uses.
        expect(resolveWikilinkToVaultPath(nfd, "Návrh", "Notes/Úvod.md".normalize("NFD"))).toBe(`Notes/${disk}`);
    });
});
