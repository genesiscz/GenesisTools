import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
        const mktreeInput = Object.entries(blobShas)
            .map(([path, sha]) => `100644 blob ${sha}\t${path}`)
            .join("\n");
        const treeSha = await this.gitWithStdin(["mktree"], `${mktreeInput}\n`);

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

    async deleteRef(ref: string): Promise<void> {
        await this.git(["update-ref", "-d", ref]);
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

    private async git(args: string[]): Promise<string> {
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
        proc.stdin.write(input);
        await proc.stdin.end();
        const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exit !== 0) {
            throw new Error(`git ${args.join(" ")} (stdin) failed: ${stderr.trim()}`);
        }
        return stdout.trim();
    }
}
