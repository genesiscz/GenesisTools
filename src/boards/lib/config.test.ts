import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
    captureRoot,
    currentBranch,
    DEFAULT_ROOT,
    defaultProject,
    ensureGitExclude,
    gitProvenance,
    mintKey,
    readSetConfig,
    repoSlugFromRemote,
    slugifyBranch,
    writeSetConfig,
} from "./config";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function initGitRepo(): string {
    const dir = makeTempDir("boards-cfg-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    return dir;
}

describe("captureRoot", () => {
    it("defaults to <cwd>/.screenshots", () => {
        expect(captureRoot("/repo")).toBe(join("/repo", DEFAULT_ROOT));
    });

    it("uses the --dir flag verbatim when given", () => {
        expect(captureRoot("/repo", "custom-dir")).toBe("custom-dir");
    });
});

describe("readSetConfig / writeSetConfig", () => {
    it("round-trips a config", async () => {
        const root = makeTempDir("boards-root-");
        const cfg = { project: "demo", branch: "main", key: "s-20260101-0000", kind: "screenshots" };
        await writeSetConfig(root, cfg);
        expect(await readSetConfig(root)).toEqual(cfg);
    });

    it("returns null when no config exists", async () => {
        const root = makeTempDir("boards-root-");
        expect(await readSetConfig(root)).toBeNull();
    });
});

describe("defaultProject / currentBranch", () => {
    it("resolves the repo basename and current branch inside a git repo", () => {
        const repo = initGitRepo();
        expect(defaultProject(repo)).toBe(basename(repo));
        expect(currentBranch(repo)).toBe("main");
    });

    it("falls back to the cwd basename outside a git repo", () => {
        const dir = makeTempDir("boards-nogit-");
        expect(defaultProject(dir)).toBe(basename(dir));
        expect(currentBranch(dir)).toBe("main");
    });
});

describe("mintKey", () => {
    it("formats as s-YYYYMMDD-HHMM in UTC", () => {
        expect(mintKey(new Date("2026-07-08T09:05:00Z"))).toBe("s-20260708-0905");
    });
});

describe("slugifyBranch", () => {
    it("mirrors the server's dev-dashboard/lib/boards/sets-store.ts algorithm", () => {
        expect(slugifyBranch("Feature/ABC_123")).toBe("feature-abc-123");
        expect(slugifyBranch("main")).toBe("main");
        expect(slugifyBranch("---")).toBe("main");
    });
});

describe("ensureGitExclude", () => {
    it("appends the capture root once and is idempotent", async () => {
        const repo = initGitRepo();
        await ensureGitExclude(repo, DEFAULT_ROOT);
        await ensureGitExclude(repo, DEFAULT_ROOT);
        const content = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
        expect(content.split("\n").filter((line) => line.trim() === `${DEFAULT_ROOT}/`)).toHaveLength(1);
    });

    it("is a no-op outside a git repo", async () => {
        const dir = makeTempDir("boards-nogit2-");
        await expect(ensureGitExclude(dir, DEFAULT_ROOT)).resolves.toBeUndefined();
    });
});

describe("repoSlugFromRemote", () => {
    it("strips the git@github.com: prefix and .git suffix", () => {
        expect(repoSlugFromRemote("git@github.com:LEFTEQ/vitrinka.git")).toBe("LEFTEQ/vitrinka");
    });

    it("strips the https://github.com/ prefix and .git suffix", () => {
        expect(repoSlugFromRemote("https://github.com/LEFTEQ/vitrinka.git")).toBe("LEFTEQ/vitrinka");
    });

    it("leaves an already-bare slug untouched", () => {
        expect(repoSlugFromRemote("owner/name")).toBe("owner/name");
    });
});

describe("gitProvenance", () => {
    it("reports a short commit and owner/name repo for a repo with an origin remote", () => {
        const repo = initGitRepo();
        execFileSync("git", ["remote", "add", "origin", "git@github.com:LEFTEQ/vitrinka.git"], { cwd: repo });
        execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repo });

        const { commit, repo: slug } = gitProvenance(repo);
        expect(commit).toMatch(/^[0-9a-f]{7,}$/);
        expect(slug).toBe("LEFTEQ/vitrinka");
    });

    it("omits both fields outside a git repo", () => {
        const dir = makeTempDir("boards-noprov-");
        expect(gitProvenance(dir)).toEqual({ commit: undefined, repo: undefined });
    });
});
