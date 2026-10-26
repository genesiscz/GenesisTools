import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createGit } from "./core";
import { applyWorktreeRenames, pairStatusRenames, pairWorktreeRenames, type WorktreeSide } from "./worktree-renames";

interface Contract {
    cases: { name: string; deleted: WorktreeSide[]; untracked: WorktreeSide[]; pairs: [string, string][] }[];
}

describe("pairWorktreeRenames", () => {
    // The one copy of the cases, shared with GenesisKit's GitWorktreeRenamesTests (src/macos/lib/kit-fixtures.ts reads
    // the same folder; this package cannot import the app alias).
    const fixture = join(
        import.meta.dir,
        "../../macos/GenesisKit/Sources/GenesisKitFixtures/Git/contract-worktree-renames.json"
    );
    const contract = SafeJSON.parse(readFileSync(fixture, "utf8"), { strict: true }) as Contract;

    it("has the cases GenesisKit also passes", () => {
        expect(contract.cases.length).toBeGreaterThanOrEqual(6);
    });

    for (const item of contract.cases) {
        it(item.name, () => {
            const pairs = pairWorktreeRenames(item.deleted, item.untracked);
            expect(pairs.map((pair) => [pair.old, pair.new])).toEqual(item.pairs);
        });
    }
});

describe("pairStatusRenames", () => {
    const made: string[] = [];

    afterEach(() => {
        for (const dir of made.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    async function run(root: string, args: string[]): Promise<void> {
        const proc = Bun.spawn(["git", "-C", root, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "Alice",
                GIT_AUTHOR_EMAIL: "alice@example.com",
                GIT_COMMITTER_NAME: "Alice",
                GIT_COMMITTER_EMAIL: "alice@example.com",
            },
        });
        expect(await proc.exited).toBe(0);
    }

    it("hashes a destination beginning with a quote without breaking other pairs", async () => {
        const root = mkdtempSync(join(tmpdir(), "worktree-renames-quotes-"));
        made.push(root);
        await run(root, ["init", "-q", "-b", "main"]);
        writeFileSync(join(root, "a.md"), "first content\n");
        writeFileSync(join(root, "b.md"), "second content\n");
        await run(root, ["add", "."]);
        await run(root, ["commit", "-q", "-m", "First"]);
        renameSync(join(root, "a.md"), join(root, '"quoted.md'));
        renameSync(join(root, "b.md"), join(root, "normal.md"));
        const status = await createGit({ cwd: root }).status({ untracked: "all" });
        const entries = await pairStatusRenames(root, status.entries);
        expect(entries).toHaveLength(2);
        expect(entries.find((entry) => entry.path === '"quoted.md')).toMatchObject({ origPath: "a.md", worktree: "R" });
        expect(entries.find((entry) => entry.path === "normal.md")).toMatchObject({ origPath: "b.md", worktree: "R" });
    });

    it("preserves staged modifications, additions and rename identities after another move", async () => {
        const root = mkdtempSync(join(tmpdir(), "worktree-renames-staged-"));
        made.push(root);
        await run(root, ["init", "-q", "-b", "main"]);
        writeFileSync(join(root, "modified.md"), "before\n");
        writeFileSync(join(root, "original.md"), "rename content\n");
        await run(root, ["add", "."]);
        await run(root, ["commit", "-q", "-m", "First"]);
        writeFileSync(join(root, "modified.md"), "after\n");
        writeFileSync(join(root, "added.md"), "added content\n");
        await run(root, ["add", "."]);
        await run(root, ["mv", "original.md", "renamed.md"]);
        mkdirSync(join(root, "moved"));
        const paths = ["modified.md", "added.md", "renamed.md"];

        for (const path of paths) {
            renameSync(join(root, path), join(root, "moved", path));
        }

        const status = await createGit({ cwd: root }).status({ untracked: "all" });
        expect(await pairStatusRenames(root, status.entries)).toEqual(status.entries);
        expect(
            applyWorktreeRenames(
                status.entries,
                paths.map((path) => ({ old: path, new: `moved/${path}` }))
            )
        ).toEqual(status.entries);
        expect(status.entries.find((entry) => entry.path === "renamed.md")).toMatchObject({
            index: "R",
            worktree: "D",
            origPath: "original.md",
        });
    });

    it("turns a folder moved outside git into renames, and leaves edits, empty files and real deletions alone", async () => {
        const root = mkdtempSync(join(tmpdir(), "worktree-renames-"));
        made.push(root);
        mkdirSync(join(root, "data/run"), { recursive: true });
        writeFileSync(join(root, "data/run/compiler.ts"), "export const compiler = 1\n");
        writeFileSync(join(root, "data/run/notes.md"), "line one\n");
        writeFileSync(join(root, "data/run/empty.err"), "");
        writeFileSync(join(root, "gone.md"), "bye\n");
        await run(root, ["init", "-q", "-b", "main"]);
        await run(root, ["add", "."]);
        await run(root, ["commit", "-q", "-m", "First"]);
        mkdirSync(join(root, "moved"));
        renameSync(join(root, "data/run"), join(root, "moved/run"));
        writeFileSync(join(root, "moved/run/notes.md"), "line one, edited\n");
        rmSync(join(root, "gone.md"));

        const status = await createGit({ cwd: root }).status({ untracked: "all" });
        const entries = await pairStatusRenames(root, status.entries);
        const byPath = new Map(entries.map((entry) => [entry.path, entry]));

        expect(byPath.get("moved/run/compiler.ts")).toMatchObject({
            kind: "renamed",
            origPath: "data/run/compiler.ts",
            worktree: "R",
        });
        expect(byPath.has("data/run/compiler.ts")).toBe(false);
        expect(byPath.get("data/run/notes.md")?.worktree).toBe("D");
        expect(byPath.get("moved/run/notes.md")?.kind).toBe("untracked");
        expect(byPath.get("data/run/empty.err")?.worktree).toBe("D");
        expect(byPath.get("gone.md")?.worktree).toBe("D");
    });
});
