import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    findPublishedByPath,
    findPublishedBySlug,
    publishNote,
    unpublishNote,
} from "@app/dev-dashboard/lib/obsidian/publish";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";

describe("obsidian publish registry", () => {
    let dir = "";

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "publish-registry-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        await getDevDashboardStorage().setConfig({
            port: 3042,
            obsidianVault: "/x",
            publishedNotes: [],
            cmuxPollIntervalMs: 2000,
        });
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    test("publishNote stores a unique slug and round-trips by slug", async () => {
        const note = await publishNote("Folder/Foo.md");

        expect(note.slug.length).toBeGreaterThan(8);
        const found = await findPublishedBySlug(note.slug);
        expect(found?.vaultPath).toBe("Folder/Foo.md");
    });

    test("publishing the same path twice returns the existing entry", async () => {
        const a = await publishNote("X.md");
        const b = await publishNote("X.md");

        expect(a.slug).toBe(b.slug);
    });

    test("a path stored decomposed (macOS) and typed composed is one note: same slug, no second entry", async () => {
        const decomposed = "C\u030CEZ/Note.md";
        await getDevDashboardStorage().setConfig({
            port: 3042,
            obsidianVault: "/x",
            publishedNotes: [
                { slug: "oldslug1234567", vaultPath: decomposed, publishedAt: "2026-01-01T00:00:00.000Z" },
            ],
            cmuxPollIntervalMs: 2000,
        });

        const composed = decomposed.normalize("NFC");
        expect(composed).not.toBe(decomposed);
        expect((await publishNote(composed)).slug).toBe("oldslug1234567");
        expect((await findPublishedByPath(composed))?.slug).toBe("oldslug1234567");
        expect((await findPublishedByPath(decomposed))?.slug).toBe("oldslug1234567");
    });

    test("unpublishNote removes the entry", async () => {
        const note = await publishNote("Y.md");

        await unpublishNote(note.slug);

        const found = await findPublishedBySlug(note.slug);
        expect(found).toBeUndefined();
    });

    test("findPublishedByPath reverse-lookup", async () => {
        const note = await publishNote("Z.md");
        const found = await findPublishedByPath("Z.md");

        expect(found?.slug).toBe(note.slug);
    });
});
