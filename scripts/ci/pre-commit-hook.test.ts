import { beforeAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runs the real `.githooks/pre-commit` in a scratch repository. The hook formats each staged blob by piping it
 * through `biome check --write --stdin-file-path`. For a path biome has no handler for (Swift, Markdown) and that is
 * not on disk, biome prints NOTHING and exits 0, and the hook used to write that empty output back as the staged
 * blob: a file staged and then moved or deleted in the working tree was committed empty (2026-10-13, found when a
 * GenesisKit agent's Swift commits came out with empty test and store files).
 */

const ROOT = resolve(import.meta.dir, "../..");

// A test run inside another git process (a hook, a rebase --exec) inherits GIT_DIR / GIT_INDEX_FILE, which would
// point every git call below at the outer repository.
const env: Record<string, string | undefined> = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_INDEX_FILE;
delete env.GIT_WORK_TREE;

// The scratch repo lives under the test temp root, which the bun test preload removes on a green exit.
let repo = "";

function git(...args: string[]): { code: number; out: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

function write(path: string, text: string): void {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
}

function headBlob(path: string): string {
    return git("show", `HEAD:${path}`).out;
}

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gt-pre-commit-hook-"));
    expect(git("init", "-q", ".").code).toBe(0);
    git("config", "user.name", "Hook Test");
    git("config", "user.email", "hook-test@example.com");
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    copyFileSync(join(ROOT, "biome.json"), join(repo, "biome.json"));
    mkdirSync(join(repo, ".githooks"));
    copyFileSync(join(ROOT, ".githooks", "pre-commit"), join(repo, ".githooks", "pre-commit"));
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
    git("config", "core.hooksPath", ".githooks");
    write("tsconfig.json", '{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true},"files":["ok.ts"]}\n');
    write("ok.ts", "export const ok = 1;\n");
    write(".gitignore", "node_modules\naside\n");
    mkdirSync(join(repo, "aside"));
    git("add", ".gitignore", "biome.json", "tsconfig.json", "ok.ts", ".githooks/pre-commit");
    const init = git("commit", "-qm", "init");
    expect(init.code, init.out).toBe(0);
});

describe("pre-commit hook: staged content survives the biome pass", () => {
    test("a staged Swift file whose working copy was moved away is committed with its staged content", () => {
        const staged = "import Foundation\nlet b = 1\n";
        write("src/app/B.swift", staged);
        git("add", "src/app/B.swift");
        renameSync(join(repo, "src/app/B.swift"), join(repo, "aside/B.swift"));
        const commit = git("commit", "-qm", "swift moved after staging");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/B.swift")).toBe(staged);
    }, 60_000);

    test("a staged Markdown file whose working copy was moved away is committed with its staged content", () => {
        const staged = "# Notes\n\nSome text.\n";
        write("src/app/C.md", staged);
        git("add", "src/app/C.md");
        renameSync(join(repo, "src/app/C.md"), join(repo, "aside/C.md"));
        const commit = git("commit", "-qm", "markdown moved after staging");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/C.md")).toBe(staged);
    }, 60_000);

    test("a partly staged Swift file commits the staged hunk and keeps the unstaged hunk in the working tree", () => {
        const staged = "import Foundation\nlet a = 1\n";
        const working = `${staged}let unstaged = 2\n`;
        write("src/app/A.swift", staged);
        git("add", "src/app/A.swift");
        write("src/app/A.swift", working);
        const commit = git("commit", "-qm", "swift partly staged");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/A.swift")).toBe(staged);
        expect(readFileSync(join(repo, "src/app/A.swift"), "utf8")).toBe(working);
    }, 60_000);

    // `biome check --write --staged` also formats the working copy (the hook's own comment says so); the point here is
    // that the commit is formatted and the unstaged line is still in the working tree afterwards.
    test("a partly staged TypeScript file is still committed formatted, and its unstaged hunk stays", () => {
        write("src/app/d.ts", "export const d = 1;\n");
        git("add", "src/app/d.ts");
        expect(git("commit", "-qm", "d").code).toBe(0);
        write("src/app/d.ts", "export const d = 1;\nexport const   e   =   2\n");
        git("add", "src/app/d.ts");
        const working = "export const d = 1;\nexport const   e   =   2\nexport const f = 3;\n";
        write("src/app/d.ts", working);
        const commit = git("commit", "-qm", "ts partly staged");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/d.ts")).toBe("export const d = 1;\nexport const e = 2;\n");
        expect(readFileSync(join(repo, "src/app/d.ts"), "utf8")).toBe(
            "export const d = 1;\nexport const e = 2;\nexport const f = 3;\n"
        );
    }, 60_000);
});
