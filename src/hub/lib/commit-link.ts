import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { type HubLinkQuery, routerLink, schemeLink } from "@genesiscz/utils/browser-router/router-link";
import {
    type CommandRunner,
    type CommitPr,
    type CommitPrsResult,
    type ProjectRef,
    projectRefFromRemote,
    prsOfCommit,
    spawnRunner,
} from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";
import { expandTilde } from "@genesiscz/utils/paths";
import { Storage } from "@genesiscz/utils/storage";
import { type CheckoutSource, liveCheckouts, projectCheckout } from "./pr/project-ref";
import { isHubCommitSha } from "./pr-ref";

/**
 * The hub link for a commit, as `tools hub link` prints it: the commit inside the PR or MR that holds it, else inside
 * its project. Agents built these by hand and got them wrong (a GitLab lookup that never finds an MR, owners guessed
 * from folder names, `!7555` typed as `%2190007555`); this asks the forge and the checkout instead.
 */

const log = logger.child({ component: "hub/commit-link" });
const GIT_TIMEOUT_MS = 5_000;
/** How long the forge's answer for one commit is reused: a push can add a PR to an open or unpushed commit. */
const CACHE_TTL_MS = { settled: 24 * 3_600_000, open: 10 * 60_000, unpushed: 2 * 60_000 } as const;

export interface CommitLinkPr extends CommitPr {
    /** What the hub's `pr=` takes: `owner/repo#42`, `group/app!12`. */
    ref: string;
    /** The PR's head holds every end of the link and its base none; null when its head is not in the checkout. */
    holds: boolean | null;
    /** The link names the commit that merged this PR (its squash or merge commit). */
    merge: boolean;
    /** Commits between its base and its head, when both are in the checkout: a stack's narrowest PR has the fewest. */
    commits: number | null;
}

export interface CommitLink {
    /** The commit or range as asked. */
    spec: string;
    /** Each end as a full sha when the checkout has it, else as asked. */
    ends: string[];
    checkout: string | null;
    /** The forge project's web path (`owner/repo`, `group/sub/app`). */
    project: string | null;
    /** Whether the forge has the first end; null when no forge was asked or it did not answer. */
    pushed: boolean | null;
    pr: CommitLinkPr | null;
    /** Every PR the forge associates with the commit, best first. */
    candidates: CommitLinkPr[];
    query: HubLinkQuery;
    link: string;
    /** `router`: the https link; `scheme`: the app's own link, where no router serves `/hub`. */
    via: "router" | "scheme";
    notes: string[];
}

export interface CommitLinkOptions {
    /** `<sha>` (7 to 40 hex characters) or `<from>..<to>`. */
    spec: string;
    /** A checkout path, or a forge path (`owner/repo`) looked up under the repo roots; omitted: the folder of `cwd`. */
    repo?: string;
    cwd?: string;
    runner?: CommandRunner;
    source?: () => Promise<CheckoutSource>;
    /** false: ask the forge again instead of reusing its answer. */
    cache?: boolean;
    storage?: Storage;
}

interface CachedAnswer {
    expires: number;
    answer: CommitPrsResult;
}

export async function resolveCommitLink(options: CommitLinkOptions): Promise<CommitLink> {
    const spec = options.spec.trim();

    if (!isHubCommitSha(spec)) {
        throw new Error(`${spec} is not a commit: a sha of 7 to 40 hex characters, or <from>..<to>`);
    }

    const cwd = options.cwd ?? process.cwd();
    const runner = options.runner ?? spawnRunner;
    const source = options.source ?? liveCheckouts;
    const notes: string[] = [];
    const git = async (dir: string, args: string[]): Promise<string | null> => {
        const res = await runner(["git", "-C", dir, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
        return res.code === 0 ? res.stdout.trim() : null;
    };

    const repo = options.repo?.trim();
    let dir: string | null = cwd;

    if (repo && /^[~./]/.test(repo)) {
        dir = resolve(cwd, expandTilde(repo));
    } else if (repo) {
        const found = await projectCheckout(repo, { source });
        dir = "root" in found ? found.root : null;

        if ("problem" in found) {
            notes.push(found.problem);
        }
    }

    const checkout = dir ? await git(dir, ["rev-parse", "--show-toplevel"]) : null;

    if (dir && !checkout) {
        notes.push(`${dir} is not a git checkout`);
    }

    const origin = checkout ? await git(checkout, ["remote", "get-url", "origin"]) : null;
    const project = origin ? projectRefFromRemote(origin) : null;
    const asked = spec.split("..");
    const full = await Promise.all(
        asked.map((end) => (checkout ? git(checkout, ["rev-parse", "--verify", "--quiet", `${end}^{commit}`]) : null))
    );
    const ends = asked.map((end, index) => full[index] || end.toLowerCase());
    const missing = asked.filter((_, index) => !full[index]);

    if (checkout && missing.length > 0) {
        notes.push(`${missing.join(", ")} not in ${checkout} (fetch it first)`);
    }

    let pushed: boolean | null = null;
    let candidates: CommitLinkPr[] = [];

    if (project && checkout) {
        const answer = await forgeAnswer({ project, sha: ends[0], checkout, runner, options });

        if (answer.error) {
            notes.push(`${project.web}: ${answer.error}`);
        } else {
            pushed = answer.pushed;
        }

        candidates = await Promise.all(answer.prs.map((pr) => judge({ pr, project, ends, checkout, git })));
        candidates.sort(rankPrs);
    } else if (checkout && !project) {
        notes.push(`${checkout} has no GitHub or GitLab origin, so no PR is asked for`);
    }

    const pr = candidates[0] ?? null;
    const query: HubLinkQuery = pr
        ? { pr: pr.ref, commit: spec }
        : { repo: await repoValue({ project, checkout, named: repo, ends, git, source }), commit: spec };
    const built = routerLink({
        preset: "genesis-hub",
        action: "open",
        data: query,
        fallback: () => schemeLink({ preset: "genesis-hub", action: "open", data: query }),
    });
    log.debug({ spec, project: project?.path, checkout, pr: pr?.ref, pushed, query }, "hub link: resolved");
    return {
        spec,
        ends,
        checkout,
        project: project?.path ?? null,
        pushed,
        pr,
        candidates,
        query,
        link: built.result,
        via: built.via === "router" ? "router" : "scheme",
        notes,
    };
}

/** The forge's PRs for one commit, reused from the hub's cache while it holds. */
async function forgeAnswer({
    project,
    sha,
    checkout,
    runner,
    options,
}: {
    project: ProjectRef;
    sha: string;
    checkout: string;
    runner: CommandRunner;
    options: CommitLinkOptions;
}): Promise<CommitPrsResult> {
    const storage = options.storage ?? new Storage("hub");
    const key = `commit-links/${createHash("sha1").update(`${project.host}/${project.path}@${sha}`).digest("hex")}.json`;

    if (options.cache !== false) {
        const held = await storage.getCacheFile<CachedAnswer>(key, "1 day");

        if (held && held.expires > Date.now()) {
            log.debug({ project: project.path, sha }, "hub link: the forge's answer from the cache");
            return held.answer;
        }
    }

    const answer = await prsOfCommit({ project, sha, cwd: checkout, runner });

    if (!answer.error) {
        const ttl = !answer.pushed
            ? CACHE_TTL_MS.unpushed
            : answer.prs.some((pr) => pr.state === "OPEN") || answer.prs.length === 0
              ? CACHE_TTL_MS.open
              : CACHE_TTL_MS.settled;
        await storage.putCacheFile<CachedAnswer>(key, { expires: Date.now() + ttl, answer }, "1 day");
    }

    return answer;
}

/** Whether `pr` holds the link's commits, from the checkout's git when its head is here. */
async function judge({
    pr,
    project,
    ends,
    checkout,
    git,
}: {
    pr: CommitPr;
    project: ProjectRef;
    ends: string[];
    checkout: string;
    git: (dir: string, args: string[]) => Promise<string | null>;
}): Promise<CommitLinkPr> {
    const ref = `${project.path}${project.kind === "gitlab" ? "!" : "#"}${pr.number}`;
    const merge =
        ends.length === 1 && pr.mergedSha !== null && pr.mergedSha.toLowerCase().startsWith(ends[0].toLowerCase());
    const head = pr.headSha && (await git(checkout, ["rev-parse", "--verify", "--quiet", `${pr.headSha}^{commit}`]));

    if (!head) {
        return { ...pr, ref, holds: null, merge, commits: null };
    }

    // A merged PR's commits are in its base by now: only its head decides.
    const baseCandidates = pr.state === "MERGED" ? [] : [pr.baseSha, pr.baseBranch ? `origin/${pr.baseBranch}` : null];
    let base: string | null = null;

    for (const candidate of baseCandidates) {
        base = candidate ? await git(checkout, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) : null;

        if (base) {
            break;
        }
    }

    const ancestor = async (older: string, newer: string) =>
        (await git(checkout, ["merge-base", "--is-ancestor", older, newer])) !== null;
    let holds = true;

    for (const end of ends) {
        if (!(await ancestor(end, head)) || (base !== null && (await ancestor(end, base)))) {
            holds = false;
            break;
        }
    }

    const counted = base ? await git(checkout, ["rev-list", "--count", `${base}..${head}`]) : null;
    const commits = counted !== null && /^\d+$/.test(counted) ? Number(counted) : null;
    return { ...pr, ref, holds, merge, commits };
}

/** Best first: a PR that holds the commit, the PR it merged, one that may (its head is not here), one it left. */
export function rankPrs(a: CommitLinkPr, b: CommitLinkPr): number {
    const tier = (pr: CommitLinkPr) => (pr.holds === true ? 0 : pr.merge ? 1 : pr.holds === null ? 2 : 3);
    const state = (pr: CommitLinkPr) => (pr.state === "OPEN" ? 0 : pr.state === "MERGED" ? 1 : 2);
    return (
        tier(a) - tier(b) ||
        state(a) - state(b) ||
        (a.commits ?? Number.MAX_SAFE_INTEGER) - (b.commits ?? Number.MAX_SAFE_INTEGER) ||
        b.number - a.number
    );
}

/**
 * The `repo=` of a commit no PR holds: the forge path when the hub's checkout of that project has the commit (the
 * link then outlives this folder), else this checkout's path.
 */
async function repoValue({
    project,
    checkout,
    named,
    ends,
    git,
    source,
}: {
    project: ProjectRef | null;
    checkout: string | null;
    named: string | undefined;
    ends: string[];
    git: (dir: string, args: string[]) => Promise<string | null>;
    source: () => Promise<CheckoutSource>;
}): Promise<string> {
    if (project) {
        const mapped = await projectCheckout(project.path, { source });

        if ("root" in mapped) {
            const held = await Promise.all(ends.map((end) => git(mapped.root, ["cat-file", "-e", `${end}^{commit}`])));

            if (held.every((answer) => answer !== null)) {
                return project.path;
            }
        }
    }

    const value = checkout ?? named;

    if (!value) {
        throw new Error("no checkout to look for the commit in: run it inside one, or pass --repo <path|owner/repo>");
    }

    return value;
}
