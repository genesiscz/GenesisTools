// Local stack restack for safe rebase-merge (gh-stack style).
//
// GitHub's merge_method=rebase rewrites SHAs on the base, which poisons
// cascading PRs that still carry the parent's pre-rewrite commits. Instead:
//   1. Ensure the PR head is linear on base (local `git rebase` if needed)
//   2. force-with-lease push
//   3. Fast-forward the base to that tip (preserves SHAs)
//   4. After landing a parent, restack dependents with:
//        git rebase --onto <newBase> <oldParentTip> <child>
//      then force-with-lease (same algorithm as github/gh-stack cascadeRebase).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { getGhCliToken } from "@genesiscz/utils/github/octokit";
import { logger } from "@genesiscz/utils/logger";

export interface RestackBranchInput {
    owner: string;
    repo: string;
    /** Branch name to rewrite (remote heads/<branch>). */
    branch: string;
    /** Tip SHA we expect on the remote before push (lease). */
    expectedHeadSha: string;
    /** New base tip to sit on (branch name or SHA — resolved after fetch). */
    newBase: string;
    /**
     * When set: `git rebase --onto newBase oldBaseSha branch`
     * Drops commits at/before oldBaseSha (parent tip before rewrite).
     * When omitted: plain `git rebase newBase` on the branch.
     */
    oldBaseSha?: string;
    /**
     * The tips this branch's base had before each force push, newest first. A branch whose base a previous merge
     * restacked still sits on one of them, not on `oldBaseSha`, so the first of these in its history marks where its
     * own commits start. Null when the lookup failed: a branch that needs a rebase is then refused (see
     * `unknownBaseRefusal`).
     */
    priorBaseShas?: string[] | null;
}

/**
 * The error for a branch that needs a rebase while its base's earlier tips are unknown, or null when the restack may
 * go on. Without them the merge-base fallback can replay the parent's old commits into the branch and push it.
 */
export function unknownBaseRefusal(
    input: Pick<RestackBranchInput, "branch" | "newBase" | "priorBaseShas">
): Error | null {
    if (input.priorBaseShas !== null) {
        return null;
    }

    return new Error(
        `Could not read the earlier tips of ${input.branch}'s base, so the commits it must drop are unknown. ` +
            `Refusing to rebase it onto ${input.newBase}; retry the merge, or rebase ${input.branch} by hand.`
    );
}

/**
 * Where a branch's own commits start: the first candidate in its history (the parent tip at merge time, then the tips
 * its base had before each force push), or null when it carries none of them. 2026-10-13: merging #486 restacked #482
 * from 5765bd6 to f5f41a2; #487 still sat on 5765bd6, so merging #482 fell back to the merge-base and replayed both
 * parents' commits, which conflicted.
 */
export async function pickOldBase(
    candidates: string[],
    isAncestor: (sha: string) => Promise<boolean>
): Promise<string | null> {
    for (const sha of candidates) {
        if (await isAncestor(sha)) {
            return sha;
        }
    }

    return null;
}

export interface RestackBranchResult {
    /** Tip SHA after restack (and push, if rebased). */
    headSha: string;
    /** True when commits were rewritten and force-pushed. */
    rebased: boolean;
    /** True when branch was already a strict FF of newBase (no rewrite). */
    alreadyLinear: boolean;
}

/** Injectable surface so safeMergePull tests do not touch the network/disk. */
export interface StackRestackOps {
    /**
     * Ensure `branch` is a clean linear tip on `newBase`.
     * Force-with-lease pushes when a rebase rewrote commits.
     */
    restackBranch(input: RestackBranchInput): Promise<RestackBranchResult>;
}

export type RestackLog = (message: string) => void;

function writeToken(): string | undefined {
    return getGhCliToken() ?? env.github.getToken();
}

/**
 * The token reaches git through its environment (the `http.extraheader` actions/checkout uses), never through its
 * argv, which any local user can read with `ps`, nor through the temp clone's .git/config.
 */
export function gitAuthEnv(token: string | undefined): Record<string, string> | undefined {
    if (!token) {
        return undefined;
    }

    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
}

function gitAt(cwd: string, token?: string): Executor {
    return new Executor({
        prefix: "git",
        cwd,
        // Keep merge output on the caller's log path, not Executor's out.println noise.
        verbose: false,
        debug: false,
        label: "git-restack",
        env: gitAuthEnv(token),
    });
}

/**
 * The object store of the checkout this runs in, borrowed as an alternate so the fetch transfers only what it lacks.
 * A cold fetch of both tips' full history timed out at 300 s on a slow link (2026-10-14, #505); with the alternate
 * the same fetch took under a second and 4 KB.
 */
async function localObjectStore(): Promise<string | undefined> {
    const result = await gitAt(process.cwd()).exec(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return result.success && result.stdout ? join(result.stdout.trim(), "objects") : undefined;
}

async function gitOrThrow(g: Executor, args: string[], label: string, timeout = 120_000): Promise<string> {
    const result = await g.exec(args, { timeout });
    if (!result.success) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
        throw new Error(`${label} failed: ${detail || `exit ${result.exitCode}`}`);
    }

    return result.stdout;
}

/**
 * Production restack: clone into a temp dir, rebase, force-with-lease push.
 * Isolated from the caller's working tree (no dirty-index risk).
 */
export function createGitStackRestack(options?: { log?: RestackLog }): StackRestackOps {
    const log = options?.log;

    return {
        async restackBranch(input: RestackBranchInput): Promise<RestackBranchResult> {
            const { owner, repo, branch, expectedHeadSha, newBase, oldBaseSha, priorBaseShas } = input;
            const url = `https://github.com/${owner}/${repo}.git`;
            const tmpRoot = await mkdtemp(join(tmpdir(), "gt-merge-restack-"));
            const g = gitAt(tmpRoot, writeToken());

            log?.(`  restack: ${branch} onto ${newBase}${oldBaseSha ? ` (drop ≤ ${oldBaseSha.slice(0, 7)})` : ""}`);

            try {
                await gitOrThrow(g, ["init", "-q"], "git init");
                const localObjects = await localObjectStore();

                if (localObjects) {
                    await mkdir(join(tmpRoot, ".git", "objects", "info"), { recursive: true });
                    await writeFile(join(tmpRoot, ".git", "objects", "info", "alternates"), `${localObjects}\n`);
                }

                await gitOrThrow(g, ["remote", "add", "origin", url], "git remote add");
                // Fetch only the refs we need (full history of those tips — no --depth).
                await gitOrThrow(
                    g,
                    [
                        "fetch",
                        "--quiet",
                        "origin",
                        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
                        `+refs/heads/${newBase}:refs/remotes/origin/${newBase}`,
                    ],
                    `git fetch ${branch} + ${newBase}`,
                    300_000
                );

                const remoteBranch = `origin/${branch}`;
                const remoteBase = `origin/${newBase}`;

                const remoteHead = await gitOrThrow(g, ["rev-parse", remoteBranch], "rev-parse head");
                if (remoteHead !== expectedHeadSha) {
                    throw new Error(
                        `Remote ${branch} moved (expected ${expectedHeadSha.slice(0, 7)}, got ${remoteHead.slice(0, 7)}). ` +
                            `Refusing to restack — fetch and retry.`
                    );
                }

                // Already linear: base is ancestor of head (or identical).
                const anc = await g.exec(["merge-base", "--is-ancestor", remoteBase, remoteBranch]);
                if (anc.success && !oldBaseSha) {
                    log?.(`  restack: ${branch} already linear on ${newBase}`);
                    return { headSha: remoteHead, rebased: false, alreadyLinear: true };
                }

                // When using --onto with a parent tip that is already an ancestor of base
                // (parent was FF-landed without rewrite), child is often already linear.
                if (oldBaseSha) {
                    const parentOnBase = await g.exec(["merge-base", "--is-ancestor", oldBaseSha, remoteBase]);
                    const baseAncOfHead = await g.exec(["merge-base", "--is-ancestor", remoteBase, remoteBranch]);
                    if (parentOnBase.success && baseAncOfHead.success) {
                        log?.(`  restack: ${branch} already linear after parent land (no rewrite needed)`);
                        return { headSha: remoteHead, rebased: false, alreadyLinear: true };
                    }
                }

                const refusal = unknownBaseRefusal(input);
                if (refusal) {
                    throw refusal;
                }

                await gitOrThrow(g, ["checkout", "-q", "-B", "restack-work", remoteBranch], "checkout head");

                let actualOldBase = oldBaseSha;
                const candidates = [...(oldBaseSha ? [oldBaseSha] : []), ...(priorBaseShas ?? [])];
                if (candidates.length > 0) {
                    // A prior tip missing from this clone fails --is-ancestor like a tip outside the history.
                    const carried = await pickOldBase(
                        candidates,
                        async (sha) => (await g.exec(["merge-base", "--is-ancestor", sha, "HEAD"])).success
                    );

                    if (carried && carried !== oldBaseSha) {
                        actualOldBase = carried;
                        log?.(`  restack: ${branch} sits on an earlier base tip ${carried.slice(0, 7)}; dropping ≤ it`);
                    } else if (!carried && oldBaseSha) {
                        // Parent tip no longer in child history (already rebased) — mirror gh-stack fallback.
                        const mb = await g.exec(["merge-base", remoteBase, "HEAD"]);
                        if (mb.success && mb.stdout) {
                            actualOldBase = mb.stdout.trim();
                            log?.(
                                `  restack: old parent tip not ancestor; using merge-base ${actualOldBase.slice(0, 7)}`
                            );
                        } else {
                            actualOldBase = undefined;
                        }
                    }
                }

                let rebaseArgs: string[];
                if (actualOldBase) {
                    rebaseArgs = ["rebase", "--onto", remoteBase, actualOldBase, "restack-work"];
                } else {
                    rebaseArgs = ["rebase", remoteBase];
                }

                const rebase = await g.exec(rebaseArgs, { timeout: 300_000 });
                if (!rebase.success) {
                    await g.exec(["rebase", "--abort"]);
                    const detail = [rebase.stderr, rebase.stdout].filter(Boolean).join("\n").trim();
                    throw new Error(
                        `Rebase of ${branch} onto ${newBase} hit conflicts (or failed).\n` +
                            `${detail || "no git output"}\n` +
                            `Resolve locally: git fetch && git checkout ${branch} && ` +
                            (actualOldBase
                                ? `git rebase --onto origin/${newBase} ${actualOldBase.slice(0, 7)}`
                                : `git rebase origin/${newBase}`) +
                            ` && git push --force-with-lease`
                    );
                }

                const newHead = await gitOrThrow(g, ["rev-parse", "HEAD"], "rev-parse after rebase");
                if (newHead === remoteHead) {
                    log?.(`  restack: ${branch} unchanged after rebase`);
                    return { headSha: newHead, rebased: false, alreadyLinear: true };
                }

                // Explicit per-ref lease against the SHA we fetched.
                await gitOrThrow(
                    g,
                    [
                        "push",
                        "--quiet",
                        `origin`,
                        `HEAD:refs/heads/${branch}`,
                        `--force-with-lease=refs/heads/${branch}:${expectedHeadSha}`,
                    ],
                    `git push --force-with-lease ${branch}`,
                    120_000
                );

                log?.(
                    `  restack: pushed ${branch} ${remoteHead.slice(0, 7)} → ${newHead.slice(0, 7)} (force-with-lease)`
                );
                return { headSha: newHead, rebased: true, alreadyLinear: false };
            } finally {
                try {
                    await rm(tmpRoot, { recursive: true, force: true });
                } catch (err) {
                    logger.debug({ err, tmpRoot }, "Failed to clean restack temp dir");
                }
            }
        },
    };
}

/** No-op restack for unit tests / --no-restack internal paths. */
export function createNoopStackRestack(): StackRestackOps {
    return {
        async restackBranch(input) {
            return {
                headSha: input.expectedHeadSha,
                rebased: false,
                alreadyLinear: true,
            };
        },
    };
}
