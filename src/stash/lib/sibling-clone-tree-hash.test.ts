import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGitIn } from "./patch";
import { computeTreeHash, computeTreeHashSimilarity } from "./sibling-clone-tree-hash";

let work: string;
beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-tree-hash-"));
});
afterEach(async () => {
    await rm(work, { recursive: true, force: true });
});

async function initRepo(parentDir: string, name: string, filePaths: string[]): Promise<string> {
    const repo = join(parentDir, name);
    await runGitIn(parentDir, ["init", name, "--initial-branch=main"]);

    for (const fp of filePaths) {
        const absPath = join(repo, fp);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, "");
    }

    if (filePaths.length > 0) {
        await runGitIn(repo, ["add", "--all"]);
    }

    return repo;
}

describe("computeTreeHashSimilarity", () => {
    test("high-overlap pair reports similarity above threshold", async () => {
        // 9 shared out of 10 unique in A + 1 unique in B → intersection=9, union=11, sim≈0.818
        const filesA = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts"];
        const filesB = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "z.ts"];
        const repoA = await initRepo(work, "repoA", filesA);
        const repoB = await initRepo(work, "repoB", filesB);
        const sim = await computeTreeHashSimilarity(repoA, repoB);
        expect(sim).toBeGreaterThan(0.7);
    });

    test("low-overlap pair reports similarity below threshold", async () => {
        // 1 shared out of 5 in A + 5 in B → intersection=1, union=9, sim≈0.11
        const filesA = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
        const filesB = ["a.ts", "f.ts", "g.ts", "h.ts", "i.ts"];
        const repoA = await initRepo(work, "repoA", filesA);
        const repoB = await initRepo(work, "repoB", filesB);
        const sim = await computeTreeHashSimilarity(repoA, repoB);
        expect(sim).toBeLessThan(0.7);
    });

    test("two empty repos yield similarity of 0", async () => {
        const repoA = await initRepo(work, "repoA", []);
        const repoB = await initRepo(work, "repoB", []);
        const sim = await computeTreeHashSimilarity(repoA, repoB);
        expect(sim).toBe(0);
    });
});

describe("computeTreeHash", () => {
    test("same repo state produces identical hashes across calls", async () => {
        const files = ["src/index.ts", "src/utils.ts", "README.md"];
        const repo = await initRepo(work, "repoA", files);
        const hash1 = await computeTreeHash(repo);
        const hash2 = await computeTreeHash(repo);
        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64); // sha256 hex
    });
});
