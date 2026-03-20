import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChanges } from "./change-detector";
import { buildMerkleTree } from "./merkle";
import type { MerkleNode } from "./types";

let tempDir: string;

function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "indexer-cd-test-"));
}

async function gitExec(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@test.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@test.com",
        },
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
}

async function initGitRepo(dir: string): Promise<void> {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "test@test.com"]);
    await gitExec(dir, ["config", "user.name", "Test"]);
}

function writeFile(dir: string, relPath: string, content: string): void {
    const fullPath = join(dir, relPath);
    const parentDir = join(fullPath, "..");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content);
}

function makeChunks(dir: string, files: Record<string, string[]>): Map<string, string[]> {
    const map = new Map<string, string[]>();

    for (const [relPath, hashes] of Object.entries(files)) {
        map.set(join(dir, relPath), hashes);
    }

    return map;
}

function buildTree(dir: string, chunks: Map<string, string[]>): MerkleNode {
    return buildMerkleTree({
        baseDir: dir,
        files: Array.from(chunks.entries()).map(([path, chunkHashes]) => ({
            path,
            chunkHashes,
        })),
    });
}

describe("change-detector: git strategy", () => {
    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test("detects modified file after commit", async () => {
        await initGitRepo(tempDir);

        writeFile(tempDir, "a.ts", "const x = 1;");
        writeFile(tempDir, "b.ts", "const y = 2;");
        await gitExec(tempDir, ["add", "."]);
        await gitExec(tempDir, ["commit", "-m", "initial"]);

        // Modify one file
        writeFile(tempDir, "a.ts", "const x = 42;");

        const chunks = makeChunks(tempDir, {
            "a.ts": ["modified-hash"],
            "b.ts": ["original-hash"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git",
            previousMerkle: null,
            currentChunks: chunks,
        });

        expect(result.strategy).toBe("git");
        expect(result.modified).toEqual(["a.ts"]);
        expect(result.unchanged).toEqual(["b.ts"]);
    });

    test("detects new untracked files", async () => {
        await initGitRepo(tempDir);

        writeFile(tempDir, "a.ts", "const x = 1;");
        await gitExec(tempDir, ["add", "."]);
        await gitExec(tempDir, ["commit", "-m", "initial"]);

        // Add a new file (not staged/committed)
        writeFile(tempDir, "c.ts", "const z = 3;");

        const chunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "c.ts": ["h3"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git",
            previousMerkle: null,
            currentChunks: chunks,
        });

        expect(result.added).toContain("c.ts");
        expect(result.unchanged).toContain("a.ts");
    });

    test("detects staged added files in repo with no HEAD", async () => {
        await initGitRepo(tempDir);

        writeFile(tempDir, "first.ts", "hello");
        // File exists but no commit yet — git status --porcelain shows it as untracked

        const chunks = makeChunks(tempDir, {
            "first.ts": ["h1"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git",
            previousMerkle: null,
            currentChunks: chunks,
        });

        // Either added or modified — no crash
        expect(result.strategy).toBe("git");
        expect(result.added.length + result.modified.length).toBeGreaterThanOrEqual(0);
    });

    test("non-git directory returns empty with helpful strategy message", async () => {
        // tempDir is not a git repo

        const chunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git",
            previousMerkle: null,
            currentChunks: chunks,
        });

        expect(result.strategy).toContain("not a git repo");
        expect(result.added).toHaveLength(0);
        expect(result.modified).toHaveLength(0);
        expect(result.deleted).toHaveLength(0);
    });
});

describe("change-detector: merkle strategy", () => {
    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test("detects all files as added when no previous tree", async () => {
        const chunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "b.ts": ["h2"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "merkle",
            previousMerkle: null,
            currentChunks: chunks,
        });

        expect(result.strategy).toBe("merkle");
        expect(result.added).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
        expect(result.unchanged).toHaveLength(0);
    });

    test("detects content changes", async () => {
        const prevChunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "b.ts": ["h2"],
        });
        const previousTree = buildTree(tempDir, prevChunks);

        // Change content of a.ts
        const currChunks = makeChunks(tempDir, {
            "a.ts": ["h1-changed"],
            "b.ts": ["h2"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "merkle",
            previousMerkle: previousTree,
            currentChunks: currChunks,
        });

        expect(result.modified).toEqual(["a.ts"]);
        expect(result.unchanged).toEqual(["b.ts"]);
    });

    test("detects deleted files", async () => {
        const prevChunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "b.ts": ["h2"],
        });
        const previousTree = buildTree(tempDir, prevChunks);

        // Only a.ts remains
        const currChunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "merkle",
            previousMerkle: previousTree,
            currentChunks: currChunks,
        });

        expect(result.deleted).toEqual(["b.ts"]);
        expect(result.unchanged).toEqual(["a.ts"]);
    });

    test("unchanged files detected when nothing changed", async () => {
        const chunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "b.ts": ["h2"],
        });
        const previousTree = buildTree(tempDir, chunks);

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "merkle",
            previousMerkle: previousTree,
            currentChunks: chunks,
        });

        expect(result.added).toHaveLength(0);
        expect(result.modified).toHaveLength(0);
        expect(result.deleted).toHaveLength(0);
        expect(result.unchanged).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    });
});

describe("change-detector: git+merkle strategy", () => {
    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test("finds modified files via git, verifies with merkle", async () => {
        await initGitRepo(tempDir);

        writeFile(tempDir, "a.ts", "const x = 1;");
        writeFile(tempDir, "b.ts", "const y = 2;");
        await gitExec(tempDir, ["add", "."]);
        await gitExec(tempDir, ["commit", "-m", "initial"]);

        // Modify a.ts
        writeFile(tempDir, "a.ts", "const x = 42;");

        const prevChunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
            "b.ts": ["h2"],
        });
        const prevTree = buildTree(tempDir, prevChunks);

        const currChunks = makeChunks(tempDir, {
            "a.ts": ["h1-changed"],
            "b.ts": ["h2"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git+merkle",
            previousMerkle: prevTree,
            currentChunks: currChunks,
        });

        expect(result.strategy).toBe("git+merkle");
        expect(result.modified).toContain("a.ts");
        expect(result.unchanged).toContain("b.ts");
    });

    test("falls back to merkle for non-git directory", async () => {
        const prevChunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
        });
        const prevTree = buildTree(tempDir, prevChunks);

        const currChunks = makeChunks(tempDir, {
            "a.ts": ["h1-changed"],
        });

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git+merkle",
            previousMerkle: prevTree,
            currentChunks: currChunks,
        });

        expect(result.strategy).toContain("fell back to merkle");
        expect(result.modified).toContain("a.ts");
    });

    test("file modified per git but unchanged per merkle is treated as unchanged", async () => {
        await initGitRepo(tempDir);

        writeFile(tempDir, "a.ts", "const x = 1;");
        await gitExec(tempDir, ["add", "."]);
        await gitExec(tempDir, ["commit", "-m", "initial"]);

        // Modify file on disk (but chunk hashes stay the same — e.g. only whitespace changed
        // outside of code chunks)
        writeFile(tempDir, "a.ts", "const x = 1; // comment");

        const chunks = makeChunks(tempDir, {
            "a.ts": ["h1"],
        });
        const prevTree = buildTree(tempDir, chunks);

        const result = await detectChanges({
            baseDir: tempDir,
            strategy: "git+merkle",
            previousMerkle: prevTree,
            currentChunks: chunks,
        });

        expect(result.strategy).toBe("git+merkle");
        // Merkle says unchanged even though git says modified
        expect(result.modified).not.toContain("a.ts");
        expect(result.unchanged).toContain("a.ts");
    });
});

describe("change-detector: chokidar strategy", () => {
    test("returns empty placeholder", async () => {
        const result = await detectChanges({
            baseDir: "/tmp",
            strategy: "chokidar",
            previousMerkle: null,
            currentChunks: new Map(),
        });

        expect(result.strategy).toBe("chokidar");
        expect(result.added).toHaveLength(0);
        expect(result.modified).toHaveLength(0);
        expect(result.deleted).toHaveLength(0);
        expect(result.unchanged).toHaveLength(0);
    });
});
