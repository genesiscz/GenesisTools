import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    branchPolicy,
    declaredBranchNames,
    inferMainBranch,
    loadRepoConfig,
    parseRepoConfig,
    REPO_CONFIG_FILENAME,
    type RepoConfig,
    validateRepoConfig,
    writeLocalRepoConfig,
} from "./repo-config";
import { TestRepo } from "./test-repo";

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

async function repo(): Promise<TestRepo> {
    const r = await TestRepo.create({ prefix: "gt-repo-config-" });
    repos.push(r);
    return r;
}

const SAMPLE: RepoConfig = {
    git: {
        mainPrBranch: "feature/next",
        branches: [
            { name: "master", push: "confirm", environment: "prod" },
            { nameRegex: "^release/", push: "never" },
            { name: "feature/next", push: "confirm", environment: "UAT", autoDeploys: true, deployDriver: "jenkins" },
            { catchAll: true, push: "allowed" },
        ],
    },
};

describe("loadRepoConfig lookup order", () => {
    it("reports no file and both candidate paths when nothing exists", async () => {
        const r = await repo();
        const loaded = await loadRepoConfig(r.dir);
        expect(loaded.source).toBe("none");
        expect(loaded.path).toBeNull();
        expect(loaded.config).toEqual({});
        expect(loaded.paths.claude).toBe(join(r.dir, ".claude", REPO_CONFIG_FILENAME));
        expect(loaded.paths.gitDir).toBe(join(r.dir, ".git", REPO_CONFIG_FILENAME));
    });

    it("reads the common-dir file, and a linked worktree sees the same file", async () => {
        const r = await repo();
        const path = await writeLocalRepoConfig(r.dir, SAMPLE);
        expect(path).toBe(join(r.dir, ".git", REPO_CONFIG_FILENAME));
        expect(existsSync(path)).toBe(true);

        const fromMain = await loadRepoConfig(r.dir);
        expect(fromMain.source).toBe("git-dir");
        expect(fromMain.config.git?.mainPrBranch).toBe("feature/next");

        await r.branch("side");
        const wt = await r.worktreeAdd({ name: "linked", ref: "side" });
        const fromWorktree = await loadRepoConfig(wt);
        expect(fromWorktree.source).toBe("git-dir");
        expect(fromWorktree.path).toBe(path);
        expect(fromWorktree.paths.repoRoot).toBe(wt);
    });

    it("prefers .claude/ over the common dir when both exist", async () => {
        const r = await repo();
        await writeLocalRepoConfig(r.dir, { git: { mainPrBranch: "develop" } });
        mkdirSync(join(r.dir, ".claude"));
        writeFileSync(join(r.dir, ".claude", REPO_CONFIG_FILENAME), '{ "git": { "mainPrBranch": "main" } }\n');

        const loaded = await loadRepoConfig(r.dir);
        expect(loaded.source).toBe("claude");
        expect(loaded.config.git?.mainPrBranch).toBe("main");
    });

    it("tolerates comments and reports a parse error as a problem, not a throw", async () => {
        const r = await repo();
        writeFileSync(
            join(r.dir, ".git", REPO_CONFIG_FILENAME),
            '{\n  // main\n  "git": { "mainPrBranch": "main" },\n}\n'
        );
        const ok = await loadRepoConfig(r.dir);
        expect(ok.problems).toEqual([]);
        expect(ok.config.git?.mainPrBranch).toBe("main");

        writeFileSync(join(r.dir, ".git", REPO_CONFIG_FILENAME), "{ not json");
        const bad = await loadRepoConfig(r.dir);
        expect(bad.source).toBe("git-dir");
        expect(bad.problems.length).toBe(1);
        expect(bad.config).toEqual({});
    });

    it("throws outside a repository", async () => {
        const r = await repo();
        await expect(loadRepoConfig(r.root)).rejects.toThrow(/Not in a git repository/);
    });

    it("writes pretty JSON that reads back identical", async () => {
        const r = await repo();
        const path = await writeLocalRepoConfig(r.dir, SAMPLE);
        expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
        expect(parseRepoConfig(readFileSync(path, "utf8"), path).config).toEqual(SAMPLE);
    });
});

describe("validateRepoConfig", () => {
    it("accepts the documented shape", () => {
        expect(validateRepoConfig(SAMPLE)).toEqual([]);
        expect(validateRepoConfig({})).toEqual([]);
        expect(validateRepoConfig({ other: { anything: 1 } })).toEqual([]);
    });

    it("requires exactly one matcher per entry", () => {
        const problems = validateRepoConfig({
            git: { branches: [{ push: "confirm" }, { name: "a", nameRegex: "^a" }, { name: "b", catchAll: true }] },
        });
        expect(problems).toHaveLength(3);
        expect(problems.every((p) => p.includes("exactly one of"))).toBe(true);
    });

    it("rejects catchAll anywhere but last, a bad push value, a broken regex, a bad driver", () => {
        const problems = validateRepoConfig({
            git: {
                mainPrBranch: "",
                branches: [
                    { catchAll: true },
                    { nameRegex: "(", push: "maybe" },
                    { name: "x", deployDriver: "argo", autoDeploys: "yes", environment: 3 },
                ],
            },
        });
        expect(problems.some((p) => p.includes("mainPrBranch"))).toBe(true);
        expect(problems.some((p) => p.includes("catchAll") && p.includes("last"))).toBe(true);
        expect(problems.some((p) => p.includes("does not compile"))).toBe(true);
        expect(problems.some((p) => p.includes(".push must be one of"))).toBe(true);
        expect(problems.some((p) => p.includes(".deployDriver must be one of"))).toBe(true);
        expect(problems.some((p) => p.includes(".autoDeploys must be a boolean"))).toBe(true);
        expect(problems.some((p) => p.includes(".environment must be a string"))).toBe(true);
    });

    it("rejects non-object roots and sections", () => {
        expect(validateRepoConfig([])).toEqual(["the file must contain a JSON object"]);
        expect(validateRepoConfig({ git: "x" })).toEqual(["`git` must be an object"]);
        expect(validateRepoConfig({ git: { branches: {} } })).toEqual(["`git.branches` must be an array"]);
    });
});

describe("branchPolicy", () => {
    it("matches by name, by regex, by catchAll, first entry wins, and defaults to confirm", () => {
        expect(branchPolicy(SAMPLE, "master")).toMatchObject({
            push: "confirm",
            environment: "prod",
            matchedBy: "name",
        });
        expect(branchPolicy(SAMPLE, "release/2026-09")).toMatchObject({ push: "never", matchedBy: "nameRegex" });
        expect(branchPolicy(SAMPLE, "feature/next")).toMatchObject({
            push: "confirm",
            environment: "UAT",
            autoDeploys: true,
            deployDriver: "jenkins",
            matchedBy: "name",
        });
        expect(branchPolicy(SAMPLE, "feat/anything")).toMatchObject({ push: "allowed", matchedBy: "catchAll" });
        expect(branchPolicy({ git: { branches: [{ name: "x" }] } }, "x")).toMatchObject({ push: "confirm" });
        expect(branchPolicy(undefined, "x")).toEqual({ push: "confirm", matchedBy: "none" });
        expect(branchPolicy({}, "x")).toEqual({ push: "confirm", matchedBy: "none" });
    });

    it("takes the first match top-down, so a catchAll never shadows an earlier entry", () => {
        const config: RepoConfig = {
            git: {
                branches: [
                    { nameRegex: "^feat/", push: "never" },
                    { catchAll: true, push: "allowed" },
                ],
            },
        };
        expect(branchPolicy(config, "feat/x").push).toBe("never");
        expect(branchPolicy(config, "fix/x").push).toBe("allowed");
    });

    it("lists only exact names as declared branches", () => {
        expect(declaredBranchNames(SAMPLE)).toEqual(["master", "feature/next"]);
        expect(declaredBranchNames(undefined)).toEqual([]);
    });
});

describe("inferMainBranch", () => {
    it("reads origin's HEAD when it is set", async () => {
        const r = await repo();
        await r.addOrigin();
        expect(await inferMainBranch(r.dir)).toEqual({ branch: "master", source: "origin-head" });
    });

    it("falls back to a local master or main without an origin", async () => {
        const r = await repo();
        expect(await inferMainBranch(r.dir)).toEqual({ branch: "master", source: "local" });

        const main = await TestRepo.create({ branch: "main", prefix: "gt-repo-config-main-" });
        repos.push(main);
        expect(await inferMainBranch(main.dir)).toEqual({ branch: "main", source: "local" });
    });

    it("returns null when nothing is known", async () => {
        const trunk = await TestRepo.create({ branch: "trunk", prefix: "gt-repo-config-trunk-" });
        repos.push(trunk);
        expect(await inferMainBranch(trunk.dir)).toBeNull();
    });
});
