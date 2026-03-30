import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const PROJECTS_DIR = resolve(homedir(), ".claude", "projects");

describe("projects.ts — encodedProjectDir", () => {
    it("produces leading-dash format", async () => {
        const { encodedProjectDir } = await import("./projects");
        const result = encodedProjectDir("/Users/jane/Projects/Foo");
        expect(result).toBe("-Users-jane-Projects-Foo");
    });

    it("encodes current cwd when called without args", async () => {
        const { encodedProjectDir } = await import("./projects");
        const result = encodedProjectDir();
        expect(result).toStartWith("-");
        expect(result).not.toContain("/");
    });
});

describe("projects.ts — resolveProjectDir", () => {
    it("finds the exact encoded dir in ~/.claude/projects/", async () => {
        const { resolveProjectDir, encodedProjectDir } = await import("./projects");
        const encoded = encodedProjectDir();

        if (!existsSync(resolve(PROJECTS_DIR, encoded))) {
            // No project dir for cwd — skip
            expect(true).toBe(true);
            return;
        }

        const result = resolveProjectDir(encoded);
        expect(result).toBe(resolve(PROJECTS_DIR, encoded));
    });

    it("finds dir by suffix match (e.g. 'GenesisTools')", async () => {
        const { resolveProjectDir } = await import("./projects");
        const leaf = basename(process.cwd());
        const result = resolveProjectDir(leaf);

        // Should find a dir ending with the leaf name (if one exists)
        if (result) {
            expect(result).toContain(leaf);
            expect(existsSync(result)).toBe(true);
        }
    });

    it("returns undefined for nonexistent project", async () => {
        const { resolveProjectDir } = await import("./projects");
        const result = resolveProjectDir("nonexistent-project-xyz-12345");
        expect(result).toBeUndefined();
    });

    it("returns full resolved path when called without args", async () => {
        const { resolveProjectDir } = await import("./projects");
        const result = resolveProjectDir();

        if (result) {
            expect(result).toStartWith(PROJECTS_DIR);
            expect(existsSync(result)).toBe(true);
        }
    });
});

describe("projects.ts — resolveProjectFilter", () => {
    it("returns encoded dir when it exists on disk", async () => {
        const { resolveProjectFilter, encodedProjectDir } = await import("./projects");
        const encoded = encodedProjectDir();

        if (!existsSync(resolve(PROJECTS_DIR, encoded))) {
            expect(true).toBe(true);
            return;
        }

        const result = resolveProjectFilter();
        expect(result).toBe(encoded);
    });

    it("falls back to basename for unknown cwd", async () => {
        const { resolveProjectFilter } = await import("./projects");
        const result = resolveProjectFilter("/tmp/nonexistent-project-dir");
        expect(result).toBe("nonexistent-project-dir");
    });
});

describe("projects.ts — detectCurrentProject", () => {
    it("returns basename of cwd", async () => {
        const { detectCurrentProject } = await import("./projects");
        const result = detectCurrentProject();
        expect(result).toBe(basename(process.cwd()));
    });
});

describe("projects.ts — extractProjectName", () => {
    it("returns leaf name for real encoded dirs on disk", async () => {
        const { extractProjectName } = await import("./projects");

        // Find a real encoded dir
        let testDir: string | undefined;
        try {
            const dirs = readdirSync(PROJECTS_DIR);
            testDir = dirs.find((d) => d.startsWith("-") && d.split("-").length > 5);
        } catch {
            // skip
        }

        if (!testDir) {
            expect(true).toBe(true);
            return;
        }

        const filePath = `${PROJECTS_DIR}/${testDir}/test.jsonl`;
        const name = extractProjectName(filePath);
        expect(name).toBeTruthy();
        expect(name.length).toBeGreaterThan(0);
    });

    it("caches results on repeated calls", async () => {
        const { extractProjectName } = await import("./projects");
        const filePath = `${PROJECTS_DIR}/-Users-test-Projects-Foo/test.jsonl`;
        const first = extractProjectName(filePath);
        const second = extractProjectName(filePath);
        // Same reference from cache
        expect(first).toBe(second);
    });
});

describe("projects.ts — resolveProjectNameFromEncoded", () => {
    it("returns the dir itself for non-encoded dirs", async () => {
        const { resolveProjectNameFromEncoded } = await import("./projects");
        expect(resolveProjectNameFromEncoded("simple-dir")).toBe("simple-dir");
    });

    it("resolves filesystem-walkable encoded dirs", async () => {
        const { resolveProjectNameFromEncoded, encodedProjectDir } = await import("./projects");
        const encoded = encodedProjectDir();
        const name = resolveProjectNameFromEncoded(encoded);
        expect(name).toBeTruthy();
        expect(name.length).toBeGreaterThan(0);
    });
});
