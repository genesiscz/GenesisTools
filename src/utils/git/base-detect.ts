import { logger } from "@genesiscz/utils/logger";
import { BaseNotFoundError, createGit } from "./core";
import type { OriginDriver, PrInfo } from "./origins/types";
import { declaredBranchNames, type RepoConfig } from "./repo-config";

/**
 * Where a base came from. Every consumer prints it, because an inferred base
 * is a guess that must be confirmed before a rebase, a cascade or a prune
 * depends on it.
 */
export type BaseSource = "flag" | "pr" | "config" | "declared" | "inferred";

export interface DetectedBase {
    /** A ref that resolves locally, e.g. `origin/master`. */
    ref: string;
    source: BaseSource;
    /** One human sentence: which rule fired and with what evidence. */
    detail: string;
    /** The PR/MR that decided it, when `source` is `pr`. */
    pr?: PrInfo;
}

export interface DetectBaseOptions {
    cwd: string;
    /** The branch whose base is wanted. Without it the PR and closest-merge-base tiers are skipped. */
    branch?: string;
    /** `--base` from the command line: verified and returned as is. */
    flag?: string;
    config?: RepoConfig;
    /** Origin driver for the PR tier; omit to stay offline. */
    driver?: OriginDriver | null;
}

interface Candidate {
    ref: string;
    distance: number;
}

/** `origin/<name>` when it exists, else the local branch, else null. */
async function resolveBranchRef(git: ReturnType<typeof createGit>, name: string): Promise<string | null> {
    const short = name.replace(/^origin\//, "");

    if (await git.refExists(`refs/remotes/origin/${short}`)) {
        return `origin/${short}`;
    }

    if (await git.refExists(`refs/heads/${short}`)) {
        return short;
    }

    return null;
}

async function originHeadBranch(git: ReturnType<typeof createGit>): Promise<string | null> {
    const res = await git.executor.exec(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
    return res.success && res.stdout ? res.stdout : null;
}

/**
 * The candidate whose merge-base with `branch` is closest to the branch tip
 * (fewest commits on the branch that the candidate lacks). Ties go to
 * origin's HEAD branch, then to remote refs over local ones, then to the
 * shorter name. A LOCAL candidate at the very same commit as the branch is a
 * backup or a twin, not a base, and is skipped; a remote ref at that commit
 * (a fresh branch cut from `origin/master`) is exactly the base wanted.
 */
interface ClosestOptions {
    git: ReturnType<typeof createGit>;
    branch: string;
    candidates: string[];
    /** Origin's HEAD branch, which wins ties. */
    preferred: string | null;
}

async function closestCandidate({ git, branch, candidates, preferred }: ClosestOptions): Promise<Candidate | null> {
    const branchSha = await git.getSha(branch);
    const scored: Candidate[] = [];

    for (const ref of candidates) {
        const shaRes = await git.executor.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

        if (!shaRes.success || (shaRes.stdout === branchSha && !ref.startsWith("origin/"))) {
            continue;
        }

        const count = await git.executor.exec(["rev-list", "--count", `${ref}..${branch}`]);

        if (!count.success) {
            continue;
        }

        scored.push({ ref, distance: Number.parseInt(count.stdout, 10) || 0 });
    }

    if (scored.length === 0) {
        return null;
    }

    const rank = (c: Candidate): number => {
        if (preferred && (c.ref === preferred || c.ref === `origin/${preferred}`)) {
            return 0;
        }

        return c.ref.startsWith("origin/") ? 1 : 2;
    };

    scored.sort((a, b) => a.distance - b.distance || rank(a) - rank(b) || a.ref.length - b.ref.length);
    return scored[0];
}

async function allCandidateRefs(git: ReturnType<typeof createGit>, branch: string): Promise<string[]> {
    const skip = new Set([branch, `origin/${branch}`, "origin/HEAD", "origin"]);
    return (await git.refs(["refs/heads/", "refs/remotes/origin/"])).map((r) => r.name).filter((n) => !skip.has(n));
}

/**
 * The PR tier alone: the branch's newest PR/MR target, resolved to a local
 * ref, or null. `tools git merged --pr` uses it so a stacked child is judged
 * against its parent while every other ref keeps the run's base.
 */
export interface PrBaseOptions {
    cwd: string;
    branch: string;
    driver: OriginDriver;
}

export async function prBase({ cwd, branch, driver }: PrBaseOptions): Promise<DetectedBase | null> {
    const git = createGit({ cwd });
    const { pr } = await driver.prForHead(branch);

    if (!pr) {
        return null;
    }

    const ref = await resolveBranchRef(git, pr.target);

    if (!ref) {
        logger.debug({ branch, pr }, "base-detect: PR target does not resolve locally");
        return null;
    }

    return { ref, source: "pr", detail: `${pr.state} PR #${pr.number} targets ${pr.target}`, pr };
}

/**
 * The base-branch ladder, one place for every command that needs a base:
 *
 *   1. `flag`                        → `flag`      (verified to resolve)
 *   2. the branch's PR/MR target     → `pr`        (needs `branch` + `driver`)
 *   3. config `git.mainPrBranch`     → `config`
 *   4. closest declared branch       → `declared`  (config `branches[].name`, needs `branch`)
 *   5. closest of every origin/local ref, else origin HEAD, else master/main → `inferred`
 *
 * Throws BaseNotFoundError when nothing resolves.
 */
export async function detectBase(opts: DetectBaseOptions): Promise<DetectedBase> {
    const git = createGit({ cwd: opts.cwd });
    const { branch, config } = opts;

    if (opts.flag) {
        if (!(await git.refExists(`${opts.flag}^{commit}`))) {
            throw new BaseNotFoundError(
                `Base "${opts.flag}" does not resolve; run git fetch first or pick another ref.`
            );
        }

        return { ref: opts.flag, source: "flag", detail: "--base" };
    }

    if (branch && opts.driver) {
        const fromPr = await prBase({ cwd: opts.cwd, branch, driver: opts.driver });

        if (fromPr) {
            return fromPr;
        }
    }

    const mainPrBranch = config?.git?.mainPrBranch;

    if (mainPrBranch) {
        const ref = await resolveBranchRef(git, mainPrBranch);

        if (ref) {
            return { ref, source: "config", detail: `mainPrBranch ${mainPrBranch}` };
        }

        logger.debug({ mainPrBranch }, "base-detect: mainPrBranch does not resolve locally");
    }

    const preferred = await originHeadBranch(git);

    if (branch) {
        const declared: string[] = [];

        for (const name of declaredBranchNames(config)) {
            const ref = await resolveBranchRef(git, name);

            if (ref && ref !== branch && ref !== `origin/${branch}`) {
                declared.push(ref);
            }
        }

        const closestDeclared = await closestCandidate({ git, branch, candidates: declared, preferred });

        if (closestDeclared) {
            return {
                ref: closestDeclared.ref,
                source: "declared",
                detail: `closest declared branch, ${closestDeclared.distance} commits`,
            };
        }

        const closest = await closestCandidate({
            git,
            branch,
            candidates: await allCandidateRefs(git, branch),
            preferred,
        });

        if (closest) {
            return { ref: closest.ref, source: "inferred", detail: `closest merge-base, ${closest.distance} commits` };
        }
    }

    if (preferred) {
        return { ref: preferred, source: "inferred", detail: "origin HEAD" };
    }

    for (const candidate of ["master", "main"]) {
        const ref = await resolveBranchRef(git, candidate);

        if (ref) {
            return { ref, source: "inferred", detail: `local ${candidate}` };
        }
    }

    throw new BaseNotFoundError(
        "Could not detect a base branch: pass --base <ref>, or declare git.mainPrBranch with `tools git config init`."
    );
}

/** `origin/master (config: mainPrBranch master)` — the one-line form every command prints. */
export function describeBase(base: DetectedBase): string {
    return `${base.ref} (${base.source}: ${base.detail})`;
}
