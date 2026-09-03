import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    expandTargets,
    findNamedDirs,
    hasComposerManifest,
    isGitIgnored,
    TARGET_KIND_VALUES,
} from "@app/macos/lib/clones/targets";

function fixture(): string {
    const outer = mkdtempSync(join(tmpdir(), "gt-cl-targets-"));
    mkdirSync(join(outer, "repo", "node_modules"), { recursive: true });
    mkdirSync(join(outer, "repo", "vendor"), { recursive: true });
    mkdirSync(join(outer, "repo", "pkg", "vendor"), { recursive: true });
    mkdirSync(join(outer, "plain", "node_modules"), { recursive: true });
    writeFileSync(join(outer, "repo", ".gitignore"), "node_modules\n");
    writeFileSync(join(outer, "repo", "pkg", "composer.json"), "{}\n");
    expect(spawnSync("git", ["-C", join(outer, "repo"), "init", "-q"]).status).toBe(0);
    return outer;
}

describe("targets", () => {
    it("exposes gitignored plus the well-known install dir names", () => {
        expect([...TARGET_KIND_VALUES]).toEqual(["gitignored", "node_modules", "vendor", "Pods", ".cxx"]);
    });

    it("findNamedDirs prunes at the first match and skips .git", async () => {
        const outer = fixture();
        try {
            const found = await findNamedDirs(outer, ["node_modules", "vendor"]);
            expect(found).toEqual(
                [
                    join(outer, "plain", "node_modules"),
                    join(outer, "repo", "node_modules"),
                    join(outer, "repo", "pkg", "vendor"),
                    join(outer, "repo", "vendor"),
                ].sort()
            );
            expect(found.some((p) => p.includes(".git"))).toBe(false);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("isGitIgnored answers true / false inside a repo and null outside one", async () => {
        const outer = fixture();
        try {
            expect(await isGitIgnored(join(outer, "repo", "node_modules"))).toBe(true);
            expect(await isGitIgnored(join(outer, "repo", "vendor"))).toBe(false);
            expect(await isGitIgnored(join(outer, "plain", "node_modules"))).toBeNull();
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("hasComposerManifest requires composer.json or composer.lock beside vendor", () => {
        const outer = fixture();
        try {
            expect(hasComposerManifest(join(outer, "repo", "pkg", "vendor"))).toBe(true);
            expect(hasComposerManifest(join(outer, "repo", "vendor"))).toBe(false);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("gitignored takes ignored install dirs and dirs outside any repo, with reasons", async () => {
        const outer = fixture();
        try {
            const res = await expandTargets({ dirs: [outer], targets: ["gitignored"] });
            expect(res.roots).toEqual([join(outer, "plain", "node_modules"), join(outer, "repo", "node_modules")]);
            expect(res.skipped).toEqual([
                { path: join(outer, "repo", "pkg", "vendor"), reason: "not-ignored" },
                { path: join(outer, "repo", "vendor"), reason: "no-composer" },
            ]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("an explicit kind overrides the gitignore filter but never the composer rule", async () => {
        const outer = fixture();
        try {
            const res = await expandTargets({ dirs: [outer], targets: ["vendor"] });
            expect(res.roots).toEqual([join(outer, "repo", "pkg", "vendor")]);
            expect(res.skipped).toEqual([{ path: join(outer, "repo", "vendor"), reason: "no-composer" }]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});
