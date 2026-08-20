import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gt-catalog-"));
const catalogPath = join(dir, "models-catalog.json");

mock.module("@app/ai-proxy/lib/storage", () => ({
    getAiProxyStorage: () => ({ modelsCatalogPath: () => catalogPath }),
}));

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeCatalog(contents: string): void {
    writeFileSync(catalogPath, contents);
}

describe("loadCatalogFile", () => {
    it("returns null for valid JSON that is not a catalog", async () => {
        const { loadCatalogFile } = await import("@app/ai-proxy/lib/catalog-file");

        // The file is user-writable. `{}` parses fine, and callers then run
        // `catalog.accounts.find(...)` — which threw instead of falling back.
        // A malformed ELEMENT throws in the readers' `accounts.find(...)` too.
        for (const contents of [
            "{}",
            "[]",
            '"nope"',
            "42",
            '{"accounts":{}}',
            '{"accounts":[null]}',
            '{"accounts":[1]}',
            '{"accounts":[[]]}',
        ]) {
            writeCatalog(contents);
            expect(loadCatalogFile()).toBeNull();
        }
    });

    it("returns the catalog when it carries an accounts array", async () => {
        const { loadCatalogFile } = await import("@app/ai-proxy/lib/catalog-file");
        writeCatalog('{"accounts":[{"id":"a","models":[]}]}');

        expect(loadCatalogFile()?.accounts).toHaveLength(1);
    });

    it("returns null for unparseable content instead of throwing", async () => {
        const { loadCatalogFile } = await import("@app/ai-proxy/lib/catalog-file");
        writeCatalog("{not json");

        expect(loadCatalogFile()).toBeNull();
    });
});
