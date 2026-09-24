import { basename, dirname } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { Executor } from "@genesiscz/utils/cli";
import {
    branchWebUrl,
    commitWebUrl,
    detectOrigin,
    type OriginKind,
    originDriver,
    originWebBase,
    type PrInfo,
} from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";

/** What the hub shows about a folder: its checkout, branch and the web pages for them. */
export interface RepoFacts {
    path: string;
    /** Top of the checkout (a linked worktree's own root); null when `path` is not in a git repo. */
    root: string | null;
    /** The project name: the main checkout's folder, shared by all its worktrees. */
    repo: string | null;
    branch: string | null;
    head: string | null;
    origin: { url: string; host: string | null; kind: OriginKind | null; web: string | null } | null;
    branchUrl: string | null;
    headUrl: string | null;
    /** Present only with `withPr`: the newest PR/MR whose head is `branch`. */
    pr?: PrInfo | null;
    /** A failed PR lookup is not "no PR". */
    prError?: string | null;
}

const log = logger.child({ component: "review/repo" });

export async function repoFacts({ path, withPr = false }: { path: string; withPr?: boolean }): Promise<RepoFacts> {
    const empty: RepoFacts = {
        path,
        root: null,
        repo: null,
        branch: null,
        head: null,
        origin: null,
        branchUrl: null,
        headUrl: null,
    };
    const git = new Executor({ prefix: "git", cwd: path });
    const res = await git.exec([
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "HEAD",
        "--abbrev-ref",
        "HEAD",
    ]);

    let root: string;
    let commonDir: string;
    let head: string | null;
    let branchRef: string | null;

    if (res.success) {
        [root, commonDir, head, branchRef] = res.stdout.trim().split("\n");
    } else {
        // A branch with no commits fails `rev-parse HEAD`, yet the checkout, origin and branch name exist.
        const checkout = await git.exec(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);

        if (!checkout.success) {
            log.debug({ path, stderr: checkout.stderr }, "not a git checkout");
            return empty;
        }

        const unborn = await git.exec(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        [root, commonDir] = checkout.stdout.trim().split("\n");
        head = null;
        branchRef = unborn.success ? unborn.stdout.trim() : null;
        log.debug({ path, branch: branchRef, stderr: res.stderr }, "checkout has no commits yet");
    }

    const repo = basename(
        commonDir.endsWith("/.git") || basename(commonDir) === ".git" ? dirname(commonDir) : commonDir
    );
    const branch = branchRef && branchRef !== "HEAD" ? branchRef : null;
    const origin = await detectOrigin(path);
    const facts: RepoFacts = {
        ...empty,
        root,
        repo,
        branch,
        head,
        origin: origin ? { ...origin, web: originWebBase(origin.url) } : null,
        branchUrl: origin && branch ? branchWebUrl(origin, branch) : null,
        headUrl: origin && head ? commitWebUrl(origin, head) : null,
    };

    if (withPr) {
        const driver = branch ? await originDriver(path) : null;

        if (!driver || !branch) {
            facts.pr = null;
            facts.prError = branch ? "no gh/glab driver for this origin" : "detached HEAD";
        } else {
            const lookup = await driver.prForHead(branch);
            facts.pr = lookup.pr;
            facts.prError = lookup.error;
        }
    }

    log.debug({ path, repo, branch, kind: origin?.kind ?? null, pr: facts.pr?.number ?? null }, "repo facts");
    return facts;
}

/** Facts for several folders, in input order; one git pair per folder, four at a time. */
export async function repoFactsMany({
    paths,
    withPr = false,
}: {
    paths: string[];
    withPr?: boolean;
}): Promise<RepoFacts[]> {
    const unique = [...new Set(paths)];
    const results = await concurrentMap({
        items: unique,
        fn: (path) => repoFacts({ path, withPr }),
        concurrency: 4,
    });

    return paths.map(
        (path) =>
            results.get(path) ?? {
                path,
                root: null,
                repo: null,
                branch: null,
                head: null,
                origin: null,
                branchUrl: null,
                headUrl: null,
            }
    );
}
