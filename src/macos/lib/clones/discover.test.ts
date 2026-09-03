import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverRoots,
    partitionApfs,
    RepoNotFoundError,
    resolveRepoRoot,
    worktreeDirs,
} from "@app/macos/lib/clones/discover";

function git(cwd: string, ...args: string[]): void {
    const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    expect(res.status).toBe(0);
}

/** A parent dir holding `main` (a repo with two worktrees, one of them moved
 *  away so git reports it prunable) plus an unrelated repo. */
function fleet(): string {
    const outer = mkdtempSync(join(tmpdir(), "gt-cl-disc-"));
    const main = join(outer, "main");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q");
    writeFileSync(join(main, "README.md"), "x\n");
    git(main, "add", "README.md");
    git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
    git(main, "worktree", "add", "-q", join(outer, "main-alive"), "-b", "alive");
    git(main, "worktree", "add", "-q", join(outer, "main-gone"), "-b", "gone");
    renameSync(join(outer, "main-gone"), join(outer, "moved-away"));
    const other = join(outer, "other");
    mkdirSync(other, { recursive: true });
    git(other, "init", "-q");
    return outer;
}

describe("resolveRepoRoot", () => {
    it("finds the repo by name under one of the search dirs", () => {
        const outer = fleet();
        try {
            expect(resolveRepoRoot([outer], "main")).toBe(join(outer, "main"));
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("accepts an absolute repo path", () => {
        const outer = fleet();
        try {
            expect(resolveRepoRoot([outer], join(outer, "other"))).toBe(join(outer, "other"));
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("throws with the candidate list when the name matches nothing", () => {
        const outer = fleet();
        try {
            let err: unknown;
            try {
                resolveRepoRoot([outer], "nope");
            } catch (e) {
                err = e;
            }

            // `moved-away` still holds the `.git` FILE git worktree wrote, so it
            // is a candidate even though git now calls that worktree prunable.
            expect(err).toBeInstanceOf(RepoNotFoundError);
            expect((err as RepoNotFoundError).candidates.sort()).toEqual(["main", "main-alive", "moved-away", "other"]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("worktreeDirs", () => {
    it("returns the main checkout and live worktrees, dropping the moved-away one", async () => {
        const outer = fleet();
        try {
            const dirs = await worktreeDirs(join(outer, "main"));
            expect(dirs.some((d) => d.endsWith("/main"))).toBe(true);
            expect(dirs.some((d) => d.endsWith("/main-alive"))).toBe(true);
            expect(dirs.some((d) => d.endsWith("/main-gone"))).toBe(false);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("returns real paths and no duplicates, so a symlinked checkout is scanned once", async () => {
        const outer = fleet();
        try {
            const dirs = await worktreeDirs(join(outer, "main"));
            expect(dirs.length).toBeGreaterThan(0);
            for (const dir of dirs) {
                expect(dir).toBe(realpathSync(dir));
            }

            expect(new Set(dirs).size).toBe(dirs.length);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("partitionApfs", () => {
    it("keeps apfs roots and reports the rest with a reason", () => {
        const res = partitionApfs(["/a", "/b"], (p) => (p === "/a" ? "apfs" : "hfs"));
        expect(res.apfs).toEqual(["/a"]);
        expect(res.skipped).toEqual([{ path: "/b", reason: "not-apfs" }]);
    });

    it("keeps a root whose fs type is unknown rather than silently dropping it", () => {
        const res = partitionApfs(["/a"], () => null);
        expect(res.apfs).toEqual(["/a"]);
        expect(res.skipped).toEqual([]);
    });
});

describe("discoverRoots", () => {
    it("expands the worktrees of one repo into their install trees", async () => {
        const outer = fleet();
        try {
            mkdirSync(join(outer, "main", "node_modules", "dep"), { recursive: true });
            mkdirSync(join(outer, "main-alive", "node_modules", "dep"), { recursive: true });
            mkdirSync(join(outer, "other", "node_modules", "dep"), { recursive: true });

            // Discovery realpaths every dir, and on macOS `/var` is a symlink to
            // `/private/var`, so expectations must be built from the real path.
            const real = realpathSync(outer);
            const res = await discoverRoots({ dirs: [outer], worktreesOf: "main", targets: ["node_modules"] });
            expect(res.roots.sort()).toEqual(
                [join(real, "main", "node_modules"), join(real, "main-alive", "node_modules")].sort()
            );
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("without worktreesOf it scans every install tree under the dirs", async () => {
        const outer = fleet();
        try {
            mkdirSync(join(outer, "main", "node_modules"), { recursive: true });
            mkdirSync(join(outer, "other", "node_modules"), { recursive: true });

            const res = await discoverRoots({ dirs: [outer], targets: ["node_modules"] });
            expect(res.roots.length).toBe(2);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("reports a missing search dir instead of throwing", async () => {
        const res = await discoverRoots({ dirs: ["/definitely/not/here/gt-clones"], targets: ["node_modules"] });
        expect(res.roots).toEqual([]);
        expect(res.skipped).toEqual([{ path: "/definitely/not/here/gt-clones", reason: "missing" }]);
    });
});
