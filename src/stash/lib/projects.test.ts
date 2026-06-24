import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitIn } from "./patch";
import { detectProject, findSiblingClones, normalizeOrigin } from "./projects";

describe("normalizeOrigin", () => {
    test("strips .git suffix", () => {
        expect(normalizeOrigin("https://github.com/x/y.git")).toBe("github.com/x/y");
    });
    test("normalizes ssh form", () => {
        expect(normalizeOrigin("git@github.com:x/y.git")).toBe("github.com/x/y");
    });
    test("lowercases host", () => {
        expect(normalizeOrigin("https://GitHub.com/X/Y")).toBe("github.com/X/Y");
    });
});

let work: string;
beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-projects-"));
});
afterEach(async () => {
    await rm(work, { recursive: true, force: true });
});

describe("detectProject", () => {
    test("returns null outside git repo", async () => {
        const result = await detectProject(work);
        expect(result).toBeNull();
    });

    test("returns root + origin for a git repo", async () => {
        const repo = join(work, "a");
        await Bun.write(join(repo, ".keep"), "");
        await runGitIn(work, ["init", "a", "--initial-branch=main"]);
        await runGitIn(repo, ["remote", "add", "origin", "https://github.com/x/y.git"]);
        const result = await detectProject(repo);
        expect(result?.rootPath).toBe(await realpath(repo));
        expect(result?.origin).toBe("github.com/x/y");
    });
});

describe("findSiblingClones", () => {
    test("finds sibling dirs with same origin", async () => {
        for (const name of ["foo", "foo2", "foo-upgrade", "bar"]) {
            const repo = join(work, name);
            await Bun.write(join(repo, ".keep"), "");
            await runGitIn(work, ["init", name, "--initial-branch=main"]);
            const origin = name === "bar" ? "https://github.com/diff/diff.git" : "https://github.com/x/y.git";
            await runGitIn(repo, ["remote", "add", "origin", origin]);
        }
        const found = await findSiblingClones(join(work, "foo"));
        const names = found.map((p) => p.split("/").pop()).sort();
        expect(names).toEqual(["foo-upgrade", "foo2"]);
    });
});
