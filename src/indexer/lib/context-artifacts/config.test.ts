import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { loadContextConfig } from "./config";

describe("loadContextConfig", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("returns null when config file does not exist", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        const result = await loadContextConfig(tmpDir);
        expect(result).toBeNull();
    });

    it("parses valid config", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            SafeJSON.stringify({
                artifacts: [{ name: "schema", path: "db/schema.sql", description: "DB schema" }],
            })
        );
        const result = await loadContextConfig(tmpDir);
        expect(result?.artifacts).toHaveLength(1);
        expect(result!.artifacts![0].name).toBe("schema");
    });

    it("parses config with empty artifacts array", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({ artifacts: [] }));
        const result = await loadContextConfig(tmpDir);
        expect(result?.artifacts).toHaveLength(0);
    });

    it("parses config with no artifacts key", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({}));
        const result = await loadContextConfig(tmpDir);
        expect(result).toBeDefined();
        expect(result!.artifacts).toBeUndefined();
    });

    it("throws on invalid JSON", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), "not json{");
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("not valid JSON");
    });

    it("throws on non-object root", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify([1, 2, 3]));
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("must be a JSON object");
    });

    it("throws on missing required fields", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({ artifacts: [{ name: "x" }] }));
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("path must be a non-empty string");
    });

    it("throws on missing name field", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            SafeJSON.stringify({ artifacts: [{ path: "a.sql", description: "test" }] })
        );
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("name must be a non-empty string");
    });

    it("throws on missing description field", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            SafeJSON.stringify({ artifacts: [{ name: "x", path: "a.sql" }] })
        );
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("description must be a non-empty string");
    });

    it("throws on duplicate artifact names (case-insensitive)", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            SafeJSON.stringify({
                artifacts: [
                    { name: "schema", path: "a.sql", description: "First" },
                    { name: "Schema", path: "b.sql", description: "Duplicate" },
                ],
            })
        );
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("duplicate artifact name");
    });

    it("throws on non-array artifacts", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({ artifacts: "not-an-array" }));
        await expect(loadContextConfig(tmpDir)).rejects.toThrow('"artifacts" must be an array');
    });
});
