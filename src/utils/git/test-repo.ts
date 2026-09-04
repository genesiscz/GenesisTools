import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";

/** Fixed wall-clock anchor so every committed date is deterministic across runs. */
export const TEST_REPO_EPOCH = 1_700_000_000;

/**
 * Hermetic git environment for throwaway repositories: no global or system
 * config (gpgsign, template dirs, hooks, rerere), a fixed identity, no editor.
 * Bun.spawn snapshots the environment at process start, so every spawn passes
 * this explicitly instead of mutating process.env.
 */
export function hermeticGitEnv(epoch?: number): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = {
        ...env.getProcessEnv(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_EDITOR: "true",
    };

    if (epoch === undefined) {
        return base;
    }

    return { ...base, GIT_AUTHOR_DATE: `${epoch} +0000`, GIT_COMMITTER_DATE: `${epoch} +0000` };
}

export interface GitRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface RunGitOptions {
    cwd: string;
    args: string[];
    /** Fixed author and committer date. */
    epoch?: number;
}

/** Run git under the hermetic env; never throws, the caller reads `code`. */
export async function runGit({ cwd, args, epoch }: RunGitOptions): Promise<GitRunResult> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: hermeticGitEnv(epoch),
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { code, stdout: stdout.replace(/\n$/, ""), stderr: stderr.trim() };
}

export interface TestRepoOptions {
    /** Initial branch name (default `master`). */
    branch?: string;
    /** mkdtemp prefix (default `gt-repo-`). */
    prefix?: string;
    /** Create the seed commit (default true). */
    seed?: boolean;
}

export interface GitCallOptions {
    /** Run in another checkout (a worktree) instead of the repo. */
    cwd?: string;
    epoch?: number;
    /** Return stdout on a non-zero exit instead of throwing. */
    allowFail?: boolean;
}

export interface WriteOptions {
    file: string;
    content: string;
    cwd?: string;
}

export interface CommitOptions {
    file: string;
    content: string;
    message?: string;
    cwd?: string;
}

export interface CommitManyOptions {
    files: Record<string, string>;
    message: string;
    cwd?: string;
}

export interface CommitDeleteOptions {
    file: string;
    message?: string;
    cwd?: string;
}

export interface WorktreeAddOptions {
    /** Directory name beside the repo. */
    name: string;
    /** Branch or commit to check out. */
    ref: string;
    detach?: boolean;
}

/**
 * A throwaway repository under the OS temp dir with deterministic commit
 * dates. Shared by the `merged`, `rebase-cascade` and base-detection suites
 * and by the gt:git eval fixtures, so every scenario is built the same way.
 */
export class TestRepo {
    private nextEpoch: number;

    private constructor(
        /** The working tree (`<root>/repo`). */
        readonly dir: string,
        /** The temp root; worktrees and the bare origin live beside `repo`. */
        readonly root: string,
        epoch: number
    ) {
        this.nextEpoch = epoch;
    }

    static async create(opts: TestRepoOptions = {}): Promise<TestRepo> {
        const root = realpathSync(mkdtempSync(join(tmpdir(), opts.prefix ?? "gt-repo-")));
        const dir = join(root, "repo");
        mkdirSync(dir);
        const repo = new TestRepo(dir, root, TEST_REPO_EPOCH);
        await repo.git(["init", "-q", "-b", opts.branch ?? "master"]);

        if (opts.seed !== false) {
            await repo.commit({ file: "README.md", content: "seed\n", message: "seed" });
        }

        return repo;
    }

    /** Run git in the repo (or `cwd`); throws with stderr in the message unless `allowFail`. */
    async git(args: string[], opts: GitCallOptions = {}): Promise<string> {
        const res = await runGit({ cwd: opts.cwd ?? this.dir, args, epoch: opts.epoch });

        if (res.code !== 0 && !opts.allowFail) {
            throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`);
        }

        return res.stdout;
    }

    /** The next deterministic commit epoch: +10 s per call, so date order follows call order. */
    tick(): number {
        this.nextEpoch += 10;
        return this.nextEpoch;
    }

    /** Write a file without committing it (a dirty worktree, an untracked file). */
    write({ file, content, cwd = this.dir }: WriteOptions): void {
        const path = join(cwd, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }

    /** Write, add and commit one file at the next epoch; returns the new commit sha. */
    async commit({ file, content, message, cwd }: CommitOptions): Promise<string> {
        return this.commitMany({ files: { [file]: content }, message: message ?? `update ${file}`, cwd });
    }

    /** Write, add and commit several files as one commit; returns the new commit sha. */
    async commitMany({ files, message, cwd = this.dir }: CommitManyOptions): Promise<string> {
        for (const [file, content] of Object.entries(files)) {
            this.write({ file, content, cwd });
        }

        await this.git(["add", "--", ...Object.keys(files)], { cwd });
        await this.git(["commit", "-q", "-m", message], { cwd, epoch: this.tick() });
        return this.git(["rev-parse", "HEAD"], { cwd });
    }

    /** Remove a tracked file and commit the deletion. */
    async commitDelete({ file, message, cwd = this.dir }: CommitDeleteOptions): Promise<string> {
        await this.git(["rm", "-q", "--", file], { cwd });
        await this.git(["commit", "-q", "-m", message ?? `delete ${file}`], { cwd, epoch: this.tick() });
        return this.git(["rev-parse", "HEAD"], { cwd });
    }

    async checkout(ref: string, opts: { create?: boolean } = {}): Promise<void> {
        await this.git(opts.create ? ["checkout", "-q", "-b", ref] : ["checkout", "-q", ref]);
    }

    /** Create a branch without checking it out. */
    async branch(name: string, start = "HEAD"): Promise<void> {
        await this.git(["branch", name, start]);
    }

    async sha(ref = "HEAD"): Promise<string> {
        return this.git(["rev-parse", ref]);
    }

    async tree(ref = "HEAD"): Promise<string> {
        return this.git(["rev-parse", `${ref}^{tree}`]);
    }

    /** `git worktree add` beside the repo; returns the worktree path. */
    async worktreeAdd({ name, ref, detach }: WorktreeAddOptions): Promise<string> {
        const path = join(this.root, name);
        const args = detach ? ["worktree", "add", "-q", "--detach", path, ref] : ["worktree", "add", "-q", path, ref];
        await this.git(args);
        return path;
    }

    /**
     * A bare `origin` beside the repo with the current branch (and `branches`)
     * pushed and tracked, plus `refs/remotes/origin/HEAD` pointing at the
     * current branch. Returns the bare repo path.
     */
    async addOrigin(branches: string[] = []): Promise<string> {
        const remote = join(this.root, "origin.git");
        const init = await runGit({ cwd: this.root, args: ["init", "-q", "--bare", remote] });

        if (init.code !== 0) {
            throw new Error(`git init --bare failed: ${init.stderr}`);
        }

        await this.git(["remote", "add", "origin", remote]);
        const current = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);

        for (const branch of [current, ...branches]) {
            await this.git(["push", "-q", "-u", "origin", branch]);
        }

        await this.git(["remote", "set-head", "origin", current]);
        return remote;
    }

    /** Squash-merge `branch` into the current branch as one commit; returns its sha. */
    async squashMerge(branch: string, message = `squash ${branch}`): Promise<string> {
        await this.git(["merge", "-q", "--squash", branch]);
        await this.git(["commit", "-q", "-m", message], { epoch: this.tick() });
        return this.sha();
    }

    cleanup(): void {
        rmSync(this.root, { recursive: true, force: true });
    }
}
