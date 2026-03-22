import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { ContextArtifactSource } from "./context-artifact-source";

describe("ContextArtifactSource", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    function writeConfig(dir: string, artifacts: Array<{ name: string; path: string; description: string }>): void {
        writeFileSync(join(dir, ".genesistoolscontext.json"), SafeJSON.stringify({ artifacts }));
    }

    it("returns empty entries when no config exists", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();
        expect(entries).toHaveLength(0);
    });

    it("returns empty entries when config has no artifacts", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({}));
        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();
        expect(entries).toHaveLength(0);
    });

    it("scans a single file artifact", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "schema.sql"), "CREATE TABLE users (id INT);");
        writeConfig(tmpDir, [{ name: "db-schema", path: "schema.sql", description: "Database schema" }]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe("context::db-schema");
        expect(entries[0].content).toBe("CREATE TABLE users (id INT);");
        expect(entries[0].path).toBe("schema.sql");
        expect(entries[0].metadata?.artifactName).toBe("db-schema");
        expect(entries[0].metadata?.type).toBe("context-artifact");
    });

    it("scans a directory artifact with concatenated content", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        const docsDir = join(tmpDir, "docs");
        mkdirSync(docsDir);
        writeFileSync(join(docsDir, "api.md"), "# API Docs");
        writeFileSync(join(docsDir, "setup.md"), "# Setup Guide");

        writeConfig(tmpDir, [{ name: "documentation", path: "docs", description: "Project docs" }]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe("context::documentation");
        expect(entries[0].content).toContain("# -- api.md --");
        expect(entries[0].content).toContain("# API Docs");
        expect(entries[0].content).toContain("# -- setup.md --");
        expect(entries[0].content).toContain("# Setup Guide");
    });

    it("scans multiple artifacts", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "schema.sql"), "CREATE TABLE t;");
        writeFileSync(join(tmpDir, "openapi.yaml"), "openapi: 3.0.0");

        writeConfig(tmpDir, [
            { name: "schema", path: "schema.sql", description: "DB" },
            { name: "api-spec", path: "openapi.yaml", description: "API" },
        ]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        expect(entries).toHaveLength(2);
        expect(entries[0].id).toBe("context::schema");
        expect(entries[1].id).toBe("context::api-spec");
    });

    it("respects scan limit", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "a.txt"), "a");
        writeFileSync(join(tmpDir, "b.txt"), "b");

        writeConfig(tmpDir, [
            { name: "a", path: "a.txt", description: "A" },
            { name: "b", path: "b.txt", description: "B" },
        ]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan({ limit: 1 });

        expect(entries).toHaveLength(1);
    });

    it("hashEntry returns consistent SHA-256 for same content", () => {
        const source = new ContextArtifactSource("/tmp");
        const entry = { id: "test", content: "hello world", path: "test.txt" };

        const hash1 = source.hashEntry(entry);
        const hash2 = source.hashEntry(entry);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(16);
    });

    it("hashEntry returns different hashes for different content", () => {
        const source = new ContextArtifactSource("/tmp");
        const entry1 = { id: "a", content: "hello", path: "a.txt" };
        const entry2 = { id: "b", content: "world", path: "b.txt" };

        expect(source.hashEntry(entry1)).not.toBe(source.hashEntry(entry2));
    });

    it("detectChanges identifies added entries", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "schema.sql"), "CREATE TABLE t;");

        writeConfig(tmpDir, [{ name: "schema", path: "schema.sql", description: "DB" }]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        const changes = source.detectChanges({
            previousHashes: null,
            currentEntries: entries,
        });

        expect(changes.added).toHaveLength(1);
        expect(changes.modified).toHaveLength(0);
        expect(changes.deleted).toHaveLength(0);
    });

    it("detectChanges identifies modified entries", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "schema.sql"), "CREATE TABLE t_new;");

        writeConfig(tmpDir, [{ name: "schema", path: "schema.sql", description: "DB" }]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        const previousHashes = new Map<string, string>();
        previousHashes.set("context::schema", "different_old_hash");

        const changes = source.detectChanges({
            previousHashes,
            currentEntries: entries,
        });

        expect(changes.modified).toHaveLength(1);
        expect(changes.modified[0].id).toBe("context::schema");
    });

    it("detectChanges identifies deleted entries", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), SafeJSON.stringify({ artifacts: [] }));

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        const previousHashes = new Map<string, string>();
        previousHashes.set("context::old-artifact", "some-hash");

        const changes = source.detectChanges({
            previousHashes,
            currentEntries: entries,
        });

        expect(changes.deleted).toHaveLength(1);
        expect(changes.deleted[0]).toBe("context::old-artifact");
    });

    it("estimateTotal returns artifact count", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "a.txt"), "a");
        writeFileSync(join(tmpDir, "b.txt"), "b");

        writeConfig(tmpDir, [
            { name: "a", path: "a.txt", description: "A" },
            { name: "b", path: "b.txt", description: "B" },
        ]);

        const source = new ContextArtifactSource(tmpDir);
        const total = await source.estimateTotal();
        expect(total).toBe(2);
    });

    it("estimateTotal returns 0 when no config", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        const source = new ContextArtifactSource(tmpDir);
        const total = await source.estimateTotal();
        expect(total).toBe(0);
    });

    it("calls onProgress during scan", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        writeFileSync(join(tmpDir, "a.txt"), "a");

        writeConfig(tmpDir, [{ name: "a", path: "a.txt", description: "A" }]);

        const source = new ContextArtifactSource(tmpDir);
        const progressCalls: Array<[number, number]> = [];

        await source.scan({
            onProgress: (current, total) => {
                progressCalls.push([current, total]);
            },
        });

        expect(progressCalls).toHaveLength(1);
        expect(progressCalls[0]).toEqual([1, 1]);
    });

    it("directory artifact skips .git and node_modules", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "cas-"));
        const projectDir = join(tmpDir, "project");
        mkdirSync(projectDir);
        mkdirSync(join(projectDir, ".git"));
        mkdirSync(join(projectDir, "node_modules"));
        mkdirSync(join(projectDir, "src"));
        writeFileSync(join(projectDir, ".git", "config"), "git internal");
        writeFileSync(join(projectDir, "node_modules", "dep.js"), "dependency");
        writeFileSync(join(projectDir, "src", "main.ts"), "code");

        writeConfig(tmpDir, [{ name: "project", path: "project", description: "Project dir" }]);

        const source = new ContextArtifactSource(tmpDir);
        const entries = await source.scan();

        expect(entries).toHaveLength(1);
        expect(entries[0].content).toContain("src/main.ts");
        expect(entries[0].content).not.toContain("git internal");
        expect(entries[0].content).not.toContain("dependency");
    });
});
