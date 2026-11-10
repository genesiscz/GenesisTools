import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type RepoConfig, repoConfigPaths, writeLocalRepoConfig } from "@genesiscz/utils/git";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { makeTestBackend } from "@genesiscz/utils/prompts/p/__tests__/test-backend";
import { setPromptBackend } from "@genesiscz/utils/testing/prompt-mock";

const answers: unknown[] = [];
const asked: string[] = [];
const answer = (kind: string): unknown => {
    asked.push(kind);
    return answers.shift();
};

// The scripted answers are untyped on purpose: each prompt hands back what the test queued, CANCEL included.
setPromptBackend({
    ...makeTestBackend(),
    select: async () => answer("select") as never,
    multiselect: async () => answer("multiselect") as never,
    text: async () => answer("text") as never,
    confirm: async () => answer("confirm") as never,
});

const { backupExitCode, parseMaxCopyMb, preWriteReasons, runConfig } = await import("./worktree");

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

    test("a local file that does not parse is refused before the first question, and keeps its bytes", async () => {
        const truncated = '{ "git": { "worktrees": { "base": ".worktrees", "install": "npm';
        writeFileSync(localPath, truncated);
        // The answers a full run from the defaults would take, so a wizard that does not refuse writes them.
        answers.push(".worktrees", "pnpm i", true, true);

        try {
            expect(await runConfig({ cwd: repo.dir })).toBe(1);

            expect(readFileSync(localPath, "utf8")).toBe(truncated);
            expect(asked).toEqual([]);
        } finally {
            unlinkSync(localPath);
        }
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

describe("tools git worktree backup, the CLI values", () => {
    test("--max-copy-mb takes a plain decimal number of MiB only", () => {
        expect(parseMaxCopyMb(undefined)).toBe(512 * 1024 * 1024);
        expect(parseMaxCopyMb("0")).toBe(0);
        expect(parseMaxCopyMb("1.5")).toBe(1.5 * 1024 * 1024);

        // Digits only, yet too large: "9".repeat(400) reads as Infinity, which would switch the ceiling off.
        for (const bad of ["", " ", "0x10", "1e3", "-1", "12 ", "Infinity", "9".repeat(400), "9".repeat(20)]) {
            expect(parseMaxCopyMb(bad)).toBeNull();
        }
    });

    test("a refusal before writing names its reason, also when no plan blocker holds it", () => {
        const inside = "The backup folder /w/backups lies inside the worktree";

        expect(preWriteReasons({ plan: { blockers: [] }, refusal: inside })).toEqual([inside]);
        expect(preWriteReasons({ plan: { blockers: ["locked"] }, refusal: "locked" })).toEqual(["locked"]);
        expect(preWriteReasons({ plan: { blockers: [] }, refusal: null })).toEqual([]);
    });

    test("a proven backup whose removal was refused exits 2, a failed one 1", () => {
        expect(backupExitCode({ refusal: null, proven: true })).toBe(0);
        expect(backupExitCode({ refusal: "changed during the backup", proven: true })).toBe(2);
        expect(backupExitCode({ refusal: "The proof failed", proven: false })).toBe(1);
    });
});
