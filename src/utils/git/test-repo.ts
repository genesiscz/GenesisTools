import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * Pristine repositories built once per process and copied for every later `create()`.
 *
 * Building one costs SEVEN `git` processes (init, three `config`, then add/commit/rev-parse
 * for the seed) and ~55 ms on an idle machine. `merged.test.ts` alone builds 39 of them
 * inside 1359 total git spawns, and its whole runtime is spawn overhead: 1359 spawns at
 * ~10 ms each accounted for 13.6 s of a 13.6 s file. Copying a directory instead costs no
 * process at all, and the copy is byte-identical to what those seven commands produced —
 * the epoch is fixed, the identity is fixed, and a fresh repo's `.git` holds no absolute
 * paths. The FIRST repo of each shape still runs the real commands, so the template can
 * never drift from them.
 */
const repoTemplates = new Map<string, { path: string; epoch: number }>();
let templateRoot: string | null = null;

function templateCacheDir(): string {
    if (templateRoot === null) {
        templateRoot = realpathSync(mkdtempSync(join(tmpdir(), "gt-repo-template-")));
        const root = templateRoot;
        process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    }

    return templateRoot;
}

/**
 * HEAD's sha read off the filesystem, or null when the layout is anything but the simple
 * loose-ref case (a linked worktree's split gitdir, a packed ref, a detached HEAD file).
 *
 * `git rev-parse HEAD` after every commit was 172 of merged.test.ts's 1359 spawns. A freshly
 * committed branch in a throwaway repo always has its loose ref on disk, so the common case
 * needs no process; null sends the caller back to the real command, which is why this cannot
 * answer differently from git rather than just faster.
 */
function looseHeadSha(cwd: string): string | null {
    const dotGit = join(cwd, ".git");

    if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) {
        return null;
    }

    const head = readFileSync(join(dotGit, "HEAD"), "utf8").trim();

    if (!head.startsWith("ref: ")) {
        return /^[0-9a-f]{40}$/.test(head) ? head : null;
    }

    const loose = resolve(dotGit, head.slice("ref: ".length).trim());

    if (!existsSync(loose)) {
        return null;
    }

    const sha = readFileSync(loose, "utf8").trim();

    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * A throwaway repository under the OS temp dir with deterministic commit
 * dates. Shared by the `merged`, `rebase-cascade` and base-detection suites
 * and by the gt:git eval fixtures, so every scenario is built the same way.
 */
export class TestRepo {
    /** Read by `fromScenario` to record where a cached setup left the epoch ladder. */
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
        const branch = opts.branch ?? "master";
        const seeded = opts.seed !== false;
        const shape = `${branch}::${seeded}`;
        const template = repoTemplates.get(shape);

        if (template !== undefined) {
            cpSync(template.path, dir, { recursive: true });
            // A copy resumes on the epoch the real build ended on, or two repos of the same
            // shape would disagree on dates. The seed commit alone consumes one tick; a
            // scenario consumes as many as its setup made commits, which is why the number is
            // recorded rather than recomputed.
            return new TestRepo(dir, root, template.epoch);
        }

        mkdirSync(dir);
        const repo = new TestRepo(dir, root, TEST_REPO_EPOCH);
        await repo.git(["init", "-q", "-b", branch]);

        // The identity and the signing switch have to live in the repo's OWN config, not only in
        // hermeticGitEnv(): these fixtures exist to drive the production git executor, which spawns
        // git with the ambient environment and therefore reads the machine's global ~/.gitconfig.
        // A developer box hides the gap behind its own identity; a runner has none, so every commit
        // the code under test makes died with "Committer identity unknown", `git rebase` stopped
        // mid-way, and the cascade suite read the halted rebase as a merge conflict.
        await repo.git(["config", "user.name", "Test"]);
        await repo.git(["config", "user.email", "test@example.com"]);
        await repo.git(["config", "commit.gpgsign", "false"]);

        if (seeded) {
            await repo.commit({ file: "README.md", content: "seed\n", message: "seed" });
        }

        // 🛑 A unique directory per template, never a name derived from the shape alone. The
        // old derivation collapsed every non-alphanumeric run to "-", so `feature/a::true` and
        // `feature-a::true` named ONE directory. `repoTemplates` keys on the full shape, so the
        // second branch missed the cache, rebuilt, and copied itself over the first branch's
        // template. git writes its object files read-only (0444), so that second copy did not
        // even silently win the race — it threw EACCES out of `TestRepo.create` and took the
        // whole suite with it. The Map is the index; this name only has to be unique, and the
        // sanitised prefix is kept so a leftover directory still says which shape it holds.
        const cached = join(mkdtempSync(join(templateCacheDir(), `${shape.replace(/[^a-z0-9]+/gi, "-")}-`)), "repo");
        cpSync(dir, cached, { recursive: true });
        repoTemplates.set(shape, { path: cached, epoch: repo.nextEpoch });

        return repo;
    }

    /**
     * A repository whose SETUP is also built once per process and copied after that.
     *
     * `create()` caches the pristine repo; this caches a whole scenario on top of it. In
     * merged.test.ts, 26 of 31 repositories were immediately given the same two-commit feature
     * branch, and that helper alone costs eight git processes (checkout -b, two commits at
     * three processes each, checkout back) — 208 of the file's 1008 spawns, rebuilt identically
     * every time. The bytes are deterministic for the same reason `create()`'s are: fixed
     * content, fixed identity and a fixed epoch ladder.
     *
     * `name` must describe everything `setup` does, because it is the cache key. Two different
     * setups under one name would hand the second caller the first one's repository.
     */
    static async fromScenario(
        name: string,
        setup: (repo: TestRepo) => Promise<void>,
        opts: TestRepoOptions = {}
    ): Promise<TestRepo> {
        const shape = `scenario:${name}::${opts.branch ?? "master"}::${opts.seed !== false}`;
        const cached = repoTemplates.get(shape);

        if (cached !== undefined) {
            const root = realpathSync(mkdtempSync(join(tmpdir(), opts.prefix ?? "gt-repo-")));
            const dir = join(root, "repo");
            cpSync(cached.path, dir, { recursive: true });

            return new TestRepo(dir, root, cached.epoch);
        }

        const repo = await TestRepo.create(opts);
        await setup(repo);
        const stored = join(mkdtempSync(join(templateCacheDir(), `${shape.replace(/[^a-z0-9]+/gi, "-")}-`)), "repo");
        cpSync(repo.dir, stored, { recursive: true });
        repoTemplates.set(shape, { path: stored, epoch: repo.nextEpoch });

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
        return this.head(cwd);
    }

    /** Remove a tracked file and commit the deletion. */
    async commitDelete({ file, message, cwd = this.dir }: CommitDeleteOptions): Promise<string> {
        await this.git(["rm", "-q", "--", file], { cwd });
        await this.git(["commit", "-q", "-m", message ?? `delete ${file}`], { cwd, epoch: this.tick() });
        return this.head(cwd);
    }

    /** HEAD's sha, off the filesystem when the ref is loose and via git when it is not. */
    private async head(cwd: string): Promise<string> {
        return looseHeadSha(cwd) ?? (await this.git(["rev-parse", "HEAD"], { cwd }));
    }

    async checkout(ref: string, opts: { create?: boolean } = {}): Promise<void> {
        await this.git(opts.create ? ["checkout", "-q", "-b", ref] : ["checkout", "-q", ref]);
    }

    /** Create a branch without checking it out. */
    async branch(name: string, start = "HEAD"): Promise<void> {
        await this.git(["branch", name, start]);
    }

    async sha(ref = "HEAD"): Promise<string> {
        return ref === "HEAD" ? this.head(this.dir) : this.git(["rev-parse", ref]);
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
