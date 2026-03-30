import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECTS_DIR, encodedProjectDir } from "./projects";

describe("discovery.ts — discoverSessionFiles", () => {
    it("returns files when allProjects is true", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const files = await discoverSessionFiles({ allProjects: true });
        expect(files.length).toBeGreaterThan(0);
        expect(files[0]).toEndWith(".jsonl");
    });

    it("scopes to current project by default", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const all = await discoverSessionFiles({ allProjects: true });
        const scoped = await discoverSessionFiles();

        // Scoped should be fewer (or equal) than all
        expect(scoped.length).toBeLessThanOrEqual(all.length);
    });

    it("accepts encoded project dir filter", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const encoded = encodedProjectDir();
        const dir = resolve(PROJECTS_DIR, encoded);

        if (!existsSync(dir)) {
            expect(true).toBe(true);
            return;
        }

        const files = await discoverSessionFiles({ project: encoded });
        expect(files.length).toBeGreaterThan(0);

        // All files should be under the project dir (or its worktree variants)
        for (const f of files) {
            expect(f).toContain(PROJECTS_DIR);
        }
    });

    it("excludes subagent files by default", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const files = await discoverSessionFiles({ excludeSubagents: true });

        for (const f of files) {
            expect(f).not.toContain("/subagents/");
            const name = f.split("/").pop() || "";
            expect(name.startsWith("agent-")).toBe(false);
        }
    });

    it("includes subagents when requested", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const withSub = await discoverSessionFiles({ includeSubagents: true, allProjects: true });
        const withoutSub = await discoverSessionFiles({ excludeSubagents: true, allProjects: true });

        // With subagents should have more or equal files
        expect(withSub.length).toBeGreaterThanOrEqual(withoutSub.length);
    });

    it("returns only subagent files when subagentsOnly", async () => {
        const { discoverSessionFiles } = await import("./discovery");
        const files = await discoverSessionFiles({ subagentsOnly: true, allProjects: true });

        if (files.length === 0) {
            expect(true).toBe(true);
            return;
        }

        for (const f of files) {
            const isSubagent = f.includes("/subagents/") || (f.split("/").pop() || "").startsWith("agent-");
            expect(isSubagent).toBe(true);
        }
    });
});

describe("discovery.ts — discoverSessionFilesInDir", () => {
    it("returns jsonl files from a specific dir", async () => {
        const { discoverSessionFilesInDir } = await import("./discovery");
        const encoded = encodedProjectDir();
        const dir = resolve(PROJECTS_DIR, encoded);

        if (!existsSync(dir)) {
            expect(true).toBe(true);
            return;
        }

        const files = discoverSessionFilesInDir(dir);
        expect(files.length).toBeGreaterThan(0);

        for (const f of files) {
            expect(f).toEndWith(".jsonl");
        }
    });

    it("excludes agent files when requested", async () => {
        const { discoverSessionFilesInDir } = await import("./discovery");
        const encoded = encodedProjectDir();
        const dir = resolve(PROJECTS_DIR, encoded);

        if (!existsSync(dir)) {
            expect(true).toBe(true);
            return;
        }

        const files = discoverSessionFilesInDir(dir, { excludeSubagents: true });
        for (const f of files) {
            const name = f.split("/").pop() || "";
            expect(name.startsWith("agent-")).toBe(false);
            expect(f).not.toContain("/subagents/");
        }
    });
});
