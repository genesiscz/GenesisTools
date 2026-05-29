import { describe, expect, test } from "bun:test";
import type { VaultEntry } from "@app/utils/obsidian/vault-tree";
import { resolveWikilinkToVaultPath } from "@app/utils/obsidian/wikilink-resolve";

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
});
