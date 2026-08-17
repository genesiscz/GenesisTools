import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "./project-root.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-root-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
    it("walks up to the directory holding .git, from arbitrarily deep", async () => {
        await mkdir(join(root, "repo", ".git"), { recursive: true });
        await mkdir(join(root, "repo", "a", "b", "c"), { recursive: true });

        expect(findProjectRoot(join(root, "repo", "a", "b", "c"))).toBe(join(root, "repo"));
        expect(findProjectRoot(join(root, "repo"))).toBe(join(root, "repo"));
    });

    it("returns null when no ancestor is a repo", async () => {
        await mkdir(join(root, "plain", "deep"), { recursive: true });

        expect(findProjectRoot(join(root, "plain", "deep"))).toBeNull();
    });
});
