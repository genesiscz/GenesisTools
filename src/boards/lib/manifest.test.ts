import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShot, readManifest, writeManifest } from "./manifest";

describe("readManifest", () => {
    it("returns an empty manifest when the file is missing", async () => {
        const root = mkdtempSync(join(tmpdir(), "boards-manifest-"));
        expect(await readManifest(root)).toEqual({ shots: [] });
        rmSync(root, { recursive: true, force: true });
    });

    it("throws on corrupt manifest content instead of silently resetting history", async () => {
        const root = mkdtempSync(join(tmpdir(), "boards-manifest-"));
        await writeFile(join(root, "manifest.json"), "{ not valid json");
        await expect(readManifest(root)).rejects.toThrow(/corrupt/);
        rmSync(root, { recursive: true, force: true });
    });

    it("round-trips shots", async () => {
        const root = mkdtempSync(join(tmpdir(), "boards-manifest-"));
        await writeManifest(root, { shots: [{ file: "a.png", label: "home" }] });
        expect(await readManifest(root)).toEqual({ shots: [{ file: "a.png", label: "home" }] });
        rmSync(root, { recursive: true, force: true });
    });
});

describe("appendShot", () => {
    it("appends a new shot", () => {
        const m = appendShot({ shots: [] }, { file: "a.png" });
        expect(m.shots).toEqual([{ file: "a.png" }]);
    });

    it("replaces an existing entry for the same file", () => {
        const m = appendShot({ shots: [{ file: "a.png", label: "old" }] }, { file: "a.png", label: "new" });
        expect(m.shots).toEqual([{ file: "a.png", label: "new" }]);
    });

    it("preserves the other entries' order, moving the replaced one to the end", () => {
        const m = appendShot({ shots: [{ file: "a.png" }, { file: "b.png" }] }, { file: "a.png", label: "updated" });
        expect(m.shots).toEqual([{ file: "b.png" }, { file: "a.png", label: "updated" }]);
    });
});
