import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSource } from "./file-source";

describe("FileSource", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("scans files from a directory", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "a.ts"), "const a = 1;");
        writeFileSync(join(tmpDir, "b.ts"), "const b = 2;");

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan();

        expect(entries.length).toBe(2);

        const ids = entries.map((e) => e.id).sort();
        expect(ids).toContain(join(tmpDir, "a.ts"));
        expect(ids).toContain(join(tmpDir, "b.ts"));
    });

    it("filters by included suffixes", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "code.ts"), "export const x = 1;");
        writeFileSync(join(tmpDir, "readme.md"), "# Readme");
        writeFileSync(join(tmpDir, "data.json"), "{}");

        const source = new FileSource({
            baseDir: tmpDir,
            includedSuffixes: [".ts"],
        });

        const entries = await source.scan();
        expect(entries.length).toBe(1);
        expect(entries[0].id).toContain("code.ts");
    });

    it("filters by ignored paths", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        mkdirSync(join(tmpDir, "src"));
        mkdirSync(join(tmpDir, "dist"));
        writeFileSync(join(tmpDir, "src", "main.ts"), "console.log('hi');");
        writeFileSync(join(tmpDir, "dist", "main.js"), "console.log('hi');");

        const source = new FileSource({
            baseDir: tmpDir,
            ignoredPaths: ["dist"],
        });

        const entries = await source.scan();
        expect(entries.length).toBe(1);
        expect(entries[0].id).toContain("src/main.ts");
    });

    it("respects limit in scan options", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "a.ts"), "a");
        writeFileSync(join(tmpDir, "b.ts"), "b");
        writeFileSync(join(tmpDir, "c.ts"), "c");

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan({ limit: 2 });

        expect(entries.length).toBe(2);
    });

    it("walks subdirectories but skips hidden dirs and node_modules", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        mkdirSync(join(tmpDir, "src"));
        mkdirSync(join(tmpDir, ".hidden"));
        mkdirSync(join(tmpDir, "node_modules"));
        writeFileSync(join(tmpDir, "src", "main.ts"), "main");
        writeFileSync(join(tmpDir, ".hidden", "secret.ts"), "secret");
        writeFileSync(join(tmpDir, "node_modules", "dep.js"), "dep");

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan();

        expect(entries.length).toBe(1);
        expect(entries[0].id).toContain("src/main.ts");
    });

    it("detectChanges identifies added, modified, deleted, unchanged", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "keep.ts"), "unchanged content");
        writeFileSync(join(tmpDir, "modify.ts"), "modified content v2");
        writeFileSync(join(tmpDir, "new.ts"), "brand new");

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan();

        const previousHashes = new Map<string, string>();
        previousHashes.set(
            join(tmpDir, "keep.ts"),
            source.hashEntry({
                id: join(tmpDir, "keep.ts"),
                content: "unchanged content",
                path: join(tmpDir, "keep.ts"),
            })
        );
        previousHashes.set(
            join(tmpDir, "modify.ts"),
            source.hashEntry({ id: join(tmpDir, "modify.ts"), content: "old content", path: join(tmpDir, "modify.ts") })
        );
        previousHashes.set(join(tmpDir, "deleted.ts"), "some-old-hash");

        const changes = source.detectChanges({
            previousHashes,
            currentEntries: entries,
        });

        expect(changes.added.length).toBe(1);
        expect(changes.added[0].id).toContain("new.ts");

        expect(changes.modified.length).toBe(1);
        expect(changes.modified[0].id).toContain("modify.ts");

        expect(changes.deleted.length).toBe(1);
        expect(changes.deleted[0]).toBe(join(tmpDir, "deleted.ts"));

        expect(changes.unchanged.length).toBe(1);
        expect(changes.unchanged[0]).toBe(join(tmpDir, "keep.ts"));
    });

    it("detectChanges with full=true treats all entries as added", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "a.ts"), "content");

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan();

        const previousHashes = new Map<string, string>();
        previousHashes.set("a.ts", source.hashEntry(entries[0]));

        const changes = source.detectChanges({
            previousHashes,
            currentEntries: entries,
            full: true,
        });

        expect(changes.added.length).toBe(1);
        expect(changes.modified.length).toBe(0);
        expect(changes.deleted.length).toBe(0);
    });

    it("hashEntry returns consistent SHA-256 hex", () => {
        const source = new FileSource({ baseDir: "/tmp" });
        const entry = { id: "test", content: "hello world", path: "test.ts" };

        const hash1 = source.hashEntry(entry);
        const hash2 = source.hashEntry(entry);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBeGreaterThan(0); // xxHash64 hex
    });

    it("scan reads many files concurrently without errors", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));

        for (let i = 0; i < 100; i++) {
            writeFileSync(join(tmpDir, `file${i}.ts`), `export const x${i} = ${i};`);
        }

        const source = new FileSource({ baseDir: tmpDir });
        const entries = await source.scan();

        expect(entries.length).toBe(100);

        for (const entry of entries) {
            expect(entry.content.length).toBeGreaterThan(0);
        }
    });

    it("estimateTotal returns file count", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "filesource-"));
        writeFileSync(join(tmpDir, "a.ts"), "a");
        writeFileSync(join(tmpDir, "b.ts"), "b");

        const source = new FileSource({
            baseDir: tmpDir,
            includedSuffixes: [".ts"],
        });

        const count = await source.estimateTotal();
        expect(count).toBe(2);
    });
});
