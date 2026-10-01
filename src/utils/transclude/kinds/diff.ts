import { defineTransclusion, TransclusionError } from "../registry";
import type { TransclusionContext } from "../types";
import { codeBlock, firstLine, git, repoRelative, repoRootOf } from "./shared";

/** `origin/HEAD` when the clone knows it, else the first of origin/main, origin/master, main, master. */
export async function defaultBranch(repoRoot: string, ctx: TransclusionContext): Promise<string | null> {
    const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot, ctx });

    if (head.code === 0 && head.stdout.trim()) {
        return head.stdout.trim();
    }

    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
        const found = await git(["rev-parse", "--verify", "--quiet", candidate], { cwd: repoRoot, ctx });

        if (found.code === 0) {
            return candidate;
        }
    }

    return null;
}

export const diffTransclusion = defineTransclusion({
    name: "diff",
    description:
        "A git diff as a diff block. Default: the working tree (committed and uncommitted work) against the " +
        "merge-base with the default branch. base= picks another base; staged=true shows only the index.",
    params: [
        { name: "path", type: "path", description: "Limit the diff to this file or folder; omit for the whole repo." },
        { name: "base", type: "string", description: "Diff against this commit instead of the merge-base." },
        { name: "staged", type: "bool", default: false, description: "Only the staged changes (git diff --cached)." },
    ],
    examples: [
        '{{diff path="src/question/lib/decisions/store.ts"}}',
        '{{diff base="HEAD~1"}}',
        '{{diff staged=true path="src/a.ts"}}',
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.optionalString("path");
        const repoRoot = await repoRootOf(path ?? ctx.cwd, ctx);

        if (!repoRoot) {
            throw new TransclusionError(`${path ?? ctx.cwd} is not in a git repository`);
        }

        const repoPath = path ? repoRelative(repoRoot, path) : undefined;
        const limit = repoPath !== undefined ? ["--", repoPath || "."] : [];
        const staged = params.bool("staged");
        let against = params.optionalString("base");
        let label: string;

        if (staged) {
            label = "staged changes";
        } else if (against) {
            // base= comes from the token: it must name a commit, never an option. Resolved to its SHA
            // first, so nothing the agent wrote reaches git diff as an argument.
            if (against.startsWith("-")) {
                throw new TransclusionError(`base="${against}" is not a commit`);
            }

            const resolved = await git(["rev-parse", "--verify", "--quiet", `${against}^{commit}`], {
                cwd: repoRoot,
                ctx,
            });

            if (resolved.code !== 0 || !resolved.stdout.trim()) {
                throw new TransclusionError(`base="${against}" is not a commit in ${repoRoot}`);
            }

            label = `working tree against ${against}`;
            against = resolved.stdout.trim();
        } else {
            const branch = await defaultBranch(repoRoot, ctx);

            if (!branch) {
                throw new TransclusionError("no default branch found (origin/HEAD, main, master); pass base=");
            }

            const mergeBase = await git(["merge-base", "HEAD", branch], { cwd: repoRoot, ctx });

            if (mergeBase.code !== 0) {
                throw new TransclusionError(`no merge-base between HEAD and ${branch}: ${firstLine(mergeBase.stderr)}`);
            }

            against = mergeBase.stdout.trim();
            label = `working tree against the ${branch} merge-base ${against.slice(0, 9)}`;
        }

        const args = [
            "diff",
            "--no-ext-diff",
            "--no-color",
            ...(staged ? ["--cached"] : against ? [against] : []),
            ...limit,
        ];
        const result = await git(args, { cwd: repoRoot, ctx });

        if (result.code !== 0) {
            throw new TransclusionError(`git diff failed: ${firstLine(result.stderr)}`);
        }

        const scope = repoPath ? `\`${repoPath}\`` : "the repo";
        const meta = { repoRoot, base: against ?? null, staged, path: repoPath ?? null };

        if (!result.stdout.trim()) {
            return { markdown: `_No changes in ${scope} (${label})._`, meta: { ...meta, empty: true } };
        }

        return {
            markdown: codeBlock({ text: result.stdout, lang: "diff", title: `Diff of ${scope}, ${label}` }),
            meta,
            block: true,
            source: `${repoPath ?? "repo"} ${staged ? "index" : `vs ${against?.slice(0, 9)}`}`,
        };
    },
});
