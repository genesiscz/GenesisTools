import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as realClack from "@clack/prompts";
import { type RepoConfig, repoConfigPaths, writeLocalRepoConfig } from "@genesiscz/utils/git";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";

setupStorageSandbox();

const CANCEL = Symbol("cancel");
const answers: unknown[] = [];
const asked: string[] = [];
const answer = (kind: string): unknown => {
    asked.push(kind);
    return answers.shift();
};

mock.module("@clack/prompts", () => ({
    ...realClack,
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    isCancel: (value: unknown) => value === CANCEL,
    select: async () => answer("select"),
    multiselect: async () => answer("multiselect"),
    text: async () => answer("text"),
    confirm: async () => answer("confirm"),
}));

const { runConfig } = await import("./worktree");

describe("tools git worktree config, the guided edit", () => {
    let repo: TestRepo;
    let localPath: string;
    let versionedPath: string;
    const ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "gt-worktree-config-" });
        const paths = await repoConfigPaths(repo.dir);
        localPath = paths.gitDir;
        versionedPath = paths.claude;
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    });

    afterAll(() => {
        if (ttyBefore) {
            Object.defineProperty(process.stdin, "isTTY", ttyBefore);
        } else {
            Reflect.deleteProperty(process.stdin, "isTTY");
        }

        repo.cleanup();
    });

    beforeEach(() => {
        answers.length = 0;
        asked.length = 0;

        if (existsSync(versionedPath)) {
            unlinkSync(versionedPath);
        }
    });

    const seed = async (config: RepoConfig) => {
        await writeLocalRepoConfig(repo.dir, config);
    };
    const written = (): RepoConfig => SafeJSON.parse(readFileSync(localPath, "utf8"), { unbox: true });

    test("changing only install keeps base, plansSync and the other config sections", async () => {
        await seed({
            git: { worktrees: { base: ".worktrees", install: "npm i", plansSync: true } },
            other: { keep: 1 },
        });
        answers.push("change", ["install"], "pnpm i", true);

        expect(await runConfig({ cwd: repo.dir })).toBe(0);

        expect(written()).toEqual({
            git: { worktrees: { base: ".worktrees", install: "pnpm i", plansSync: true } },
            other: { keep: 1 },
        });
    });

    test("changing only plansSync keeps base and install", async () => {
        await seed({ git: { worktrees: { base: ".worktrees", install: "npm i", plansSync: true } } });
        answers.push("change", ["plansSync"], false, true);

        expect(await runConfig({ cwd: repo.dir })).toBe(0);

        expect(written().git?.worktrees).toEqual({ base: ".worktrees", install: "npm i", plansSync: false });
    });

    test("changing only base keeps install and plansSync", async () => {
        await seed({ git: { worktrees: { base: ".claude/worktrees", install: "npm i", plansSync: true } } });
        answers.push("change", ["base"], ".worktrees", true);

        expect(await runConfig({ cwd: repo.dir })).toBe(0);

        expect(written().git?.worktrees).toEqual({ base: ".worktrees", install: "npm i", plansSync: true });
    });

    test("a policy with no install and no plansSync gets only the changed field plus the plansSync default", async () => {
        await seed({ git: { worktrees: { base: ".worktrees" } } });
        answers.push("change", ["install"], "bun i", true);

        expect(await runConfig({ cwd: repo.dir })).toBe(0);

        expect(written().git?.worktrees).toEqual({ base: ".worktrees", install: "bun i", plansSync: false });
    });

    test("keep writes nothing and never reaches a field prompt", async () => {
        const policy = { git: { worktrees: { base: ".worktrees", install: "npm i", plansSync: true } } };
        await seed(policy);
        const before = readFileSync(localPath, "utf8");
        answers.push("keep");

        expect(await runConfig({ cwd: repo.dir })).toBe(0);

        expect(readFileSync(localPath, "utf8")).toBe(before);
        expect(asked).toEqual(["select"]);
    });

    test("declining the final confirmation writes nothing", async () => {
        await seed({ git: { worktrees: { base: ".worktrees", install: "npm i", plansSync: true } } });
        const before = readFileSync(localPath, "utf8");
        answers.push("change", ["install"], "pnpm i", false);

        expect(await runConfig({ cwd: repo.dir })).toBe(1);

        expect(readFileSync(localPath, "utf8")).toBe(before);
    });

    test("a versioned policy is refused, because the local write would be shadowed and look successful", async () => {
        await seed({ git: { worktrees: { base: ".worktrees", install: "npm i", plansSync: true } } });
        const before = readFileSync(localPath, "utf8");
        mkdirSync(dirname(versionedPath), { recursive: true });
        writeFileSync(
            versionedPath,
            SafeJSON.stringify({ git: { worktrees: { base: "../", install: "make", plansSync: false } } })
        );
        answers.push("change", ["install"], "pnpm i", true);

        expect(await runConfig({ cwd: repo.dir })).toBe(1);

        expect(readFileSync(localPath, "utf8")).toBe(before);
        expect(asked).toEqual([]);
    });
});
