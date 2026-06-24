import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";

const { log } = logger.scoped("stash:store-repo");

export interface WritePatchCommitArgs {
    ref: string;
    files: Record<string, string>;
    message: string;
    parentRef?: string;
}

export class StoreRepo {
    constructor(private readonly dir: string) {}

    async init(): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        if (existsSync(join(this.dir, "HEAD"))) {
            return;
        }
        await this.git(["init", "--bare", "--initial-branch=main"]);
        log.debug({ dir: this.dir }, "initialized bare store repo");
    }

    async writePatchCommit(args: WritePatchCommitArgs): Promise<string> {
        log.debug({ ref: args.ref, fileCount: Object.keys(args.files).length }, "writePatchCommit");
        const blobShas: Record<string, string> = {};
        for (const [path, content] of Object.entries(args.files)) {
            blobShas[path] = await this.gitWithStdin(["hash-object", "-w", "--stdin"], content);
        }

        // `git mktree` rejects entries containing `/` ("fatal: path src/foo.ts contains slash"), so we
        // can't pipe `100644 blob <sha>\t<nested/path>` lines into it. Build the tree via an isolated
        // temp index instead: `update-index --add --cacheinfo` accepts nested paths and `write-tree`
        // serializes the resulting tree (subtrees and all).
        const treeSha = await this.writeTreeViaIndex(blobShas);

        const commitArgs = ["commit-tree", treeSha, "-m", args.message];
        if (args.parentRef) {
            const parentSha = await this.resolveRef(args.parentRef);
            if (parentSha) {
                commitArgs.push("-p", parentSha);
            }
        }
        const commitSha = (await this.git(commitArgs)).trim();
        await this.git(["update-ref", args.ref, commitSha]);
        return commitSha;
    }

    async resolveRef(ref: string): Promise<string | null> {
        try {
            const sha = await this.git(["rev-parse", "--verify", ref]);
            return sha.trim();
        } catch (err) {
            log.debug({ err, ref }, "resolveRef miss");
            return null;
        }
    }

    async readFileAt(ref: string, path: string): Promise<string | null> {
        try {
            return await this.git(["show", `${ref}:${path}`]);
        } catch (err) {
            log.debug({ err, ref, path }, "readFileAt miss");
            return null;
        }
    }

    /**
     * Best-effort ref delete. A missing ref is fine (drop flow may race or re-run); other failures
     * still bubble so a genuine git problem isn't silently swallowed.
     */
    async deleteRef(ref: string): Promise<void> {
        try {
            await this.git(["update-ref", "-d", ref]);
        } catch (err) {
            const exists = await this.resolveRef(ref);
            if (exists) {
                throw err;
            }
            log.debug({ ref }, "deleteRef: already absent (ignored)");
        }
    }

    async listRefs(prefix: string): Promise<string[]> {
        try {
            const out = await this.git(["for-each-ref", "--format=%(refname)", prefix]);
            return out
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
        } catch (err) {
            log.debug({ err, prefix }, "listRefs failed");
            return [];
        }
    }

    private async writeTreeViaIndex(blobShas: Record<string, string>): Promise<string> {
        const indexDir = await mkdtemp(join(tmpdir(), "stash-index-"));
        const indexFile = join(indexDir, "index");
        try {
            for (const [path, sha] of Object.entries(blobShas)) {
                await this.git(["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], {
                    GIT_INDEX_FILE: indexFile,
                });
            }
            const tree = (await this.git(["write-tree"], { GIT_INDEX_FILE: indexFile })).trim();
            return tree;
        } finally {
            await rm(indexDir, { recursive: true, force: true });
        }
    }

    private async git(args: string[], extraEnv?: Record<string, string>): Promise<string> {
        // Author/committer identity is forced here so the bare store repo doesn't depend on the user's
        // global git config (CI environments often have neither user.name nor user.email).
        const proc = Bun.spawn(["git", "--git-dir", this.dir, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "stash",
                GIT_AUTHOR_EMAIL: "stash@genesistools.local",
                GIT_COMMITTER_NAME: "stash",
                GIT_COMMITTER_EMAIL: "stash@genesistools.local",
                ...(extraEnv ?? {}),
            },
        });
        const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exit !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
        }
        return stdout;
    }

    private async gitWithStdin(args: string[], input: string): Promise<string> {
        const proc = Bun.spawn(["git", "--git-dir", this.dir, ...args], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        // Start the stdout/stderr/exit readers BEFORE writing stdin. If a future git invocation
        // streams output while consuming input (or input exceeds the OS pipe buffer ~16-64 KB on
        // macOS), waiting on stdin.end() with no reader draining stdout would deadlock.
        const drain = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        proc.stdin.write(input);
        await proc.stdin.end();
        const [stdout, stderr, exit] = await drain;
        if (exit !== 0) {
            throw new Error(`git ${args.join(" ")} (stdin) failed: ${stderr.trim()}`);
        }
        return stdout.trim();
    }
}
