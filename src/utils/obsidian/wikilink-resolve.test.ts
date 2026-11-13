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
        // macOS keeps `á` of a file name as `a` + U+0301 (NFD); a link typed in a note is NFC. The folder has an
        // accent too, so the same-folder check compares folders in NFC as well.
        const disk = "Složka/Návrh.md".normalize("NFD");
        const nfd: VaultEntry[] = [
            { name: "Návrh.md".normalize("NFD"), relativePath: "Other/Návrh.md".normalize("NFD"), isDirectory: false },
            { name: "Návrh.md".normalize("NFD"), relativePath: disk, isDirectory: false },
        ];

        expect(resolveWikilinkToVaultPath(nfd.slice(1), "Návrh".normalize("NFC"))).toBe(disk);
        expect(resolveWikilinkToVaultPath(nfd.slice(1), "Složka/Návrh.md".normalize("NFC"))).toBe(disk);
        // Of two matches, the one in the linking note's folder wins, whichever form either path uses. Both match only
        // in NFC here, and the shorter Other/Návrh.md would win if the folders were compared as spelled.
        expect(resolveWikilinkToVaultPath(nfd, "Návrh".normalize("NFC"), "Složka/Úvod.md".normalize("NFC"))).toBe(disk);
    });

    test("when both spellings exist as two files, the link opens the one it spells", () => {
        // A file system that keeps NFC and NFD names apart (Linux, a case-sensitive volume) can hold both in one folder.
        const nfc = "Notes/Návrh.md".normalize("NFC");
        const nfd = "Notes/Návrh.md".normalize("NFD");
        const twins: VaultEntry[] = [
            { name: "Návrh.md".normalize("NFC"), relativePath: nfc, isDirectory: false },
            { name: "Návrh.md".normalize("NFD"), relativePath: nfd, isDirectory: false },
        ];

        expect(resolveWikilinkToVaultPath(twins, "Notes/Návrh".normalize("NFD"))).toBe(nfd);
        expect(resolveWikilinkToVaultPath(twins, "Návrh".normalize("NFD"), "Notes/from.md")).toBe(nfd);
        expect(resolveWikilinkToVaultPath(twins, "Návrh".normalize("NFC"), "Notes/from.md")).toBe(nfc);
    });
});
