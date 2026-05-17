import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { storage } from "@app/dev-dashboard/config";
import {
    findPublishedByPath,
    findPublishedBySlug,
    publishNote,
    unpublishNote,
} from "@app/dev-dashboard/lib/obsidian/publish";

let originalConfig: string | null = null;

describe("obsidian publish registry", () => {
    beforeAll(async () => {
        const configPath = storage.getConfigPath();
        originalConfig = existsSync(configPath) ? await Bun.file(configPath).text() : null;
    });

    beforeEach(async () => {
        await storage.setConfig({ port: 3042, obsidianVault: "/x", publishedNotes: [], cmuxPollIntervalMs: 2000 });
    });

    afterAll(async () => {
        if (originalConfig === null) {
            await storage.clearConfig();
            return;
        }

        await storage.ensureDirs();
        await Bun.write(storage.getConfigPath(), originalConfig);
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
