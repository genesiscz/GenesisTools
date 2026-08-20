import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import { shareNote, toVaultRelativePath } from "./share-note";

describe("toVaultRelativePath", () => {
    const root = "/vault";

    test("keeps a vault-relative .md path", () => {
        expect(toVaultRelativePath("ČEZ/Design/Note.md", root)).toBe("ČEZ/Design/Note.md");
    });

    test("appends .md when omitted", () => {
        expect(toVaultRelativePath("ČEZ/Design/Note", root)).toBe("ČEZ/Design/Note.md");
    });

    test("converts an absolute path inside the vault", () => {
        expect(toVaultRelativePath("/vault/ČEZ/Design/Note.md", root)).toBe("ČEZ/Design/Note.md");
    });

    test("rejects a path that leaves the vault", () => {
        expect(() => toVaultRelativePath("../outside.md", root)).toThrow(/escapes vault/);
    });

    test("rejects an empty path", () => {
        expect(() => toVaultRelativePath("  ", root)).toThrow(/path required/);
    });
});

describe("shareNote", () => {
    let dir = "";
    let vault = "";

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "share-note-"));
        vault = join(dir, "vault");
        mkdirSync(join(vault, "ČEZ", "Design"), { recursive: true });
        writeFileSync(join(vault, "ČEZ", "Design", "Note.md"), "# hi\n");
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        await getDevDashboardStorage().setConfig({
            port: 3042,
            obsidianVault: vault,
            allowedHosts: ["mac.foltyn.dev"],
            publishedNotes: [],
            cmuxPollIntervalMs: 2000,
        });
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    test("publishes through the same registry as the UI and returns the public URL", async () => {
        const first = await shareNote("ČEZ/Design/Note.md");

        expect(first.vaultPath).toBe("ČEZ/Design/Note.md");
        expect(first.url).toBe(`https://mac.foltyn.dev/share/${first.slug}`);
        expect(first.slug.length).toBeGreaterThan(8);

        const second = await shareNote(join(vault, "ČEZ", "Design", "Note.md"));
        expect(second.slug).toBe(first.slug);
        expect(second.url).toBe(first.url);
    });

    test("fails when the note is missing", async () => {
        await expect(shareNote("ČEZ/Design/Missing.md")).rejects.toThrow();
    });
});
