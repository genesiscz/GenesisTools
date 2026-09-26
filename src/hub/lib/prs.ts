import { basename } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import {
    type CommandRunner,
    listPrs,
    listWorktrees,
    type OriginKind,
    type PrDetail,
    type PrListState,
    type ProjectRef,
    type PrSummary,
    parsePrUrl,
    projectRefFromRemote,
    spawnRunner,
    viewerLogin,
    viewPr,
    type WorktreeInfo,
} from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import { branchMentions, localBranchNames } from "./branches";
import { type ProposalSummary, proposalFor } from "./proposal";
import { type RepoFacts, repoFacts, repoFactsMany } from "./repo";

/** The hub's PR row: the host's PR plus where it lives on this machine. */
export interface HubPr extends PrSummary {
    /** Project folder name (the main checkout's folder). */
    repo: string;
    /** Main checkout of the project; null when the PR was opened by URL. */
    repoRoot: string | null;
    origin: { kind: OriginKind; host: string; web: string };
    /** The local worktree whose branch is the PR's head branch. */
    localWorktree: string | null;
    /** Authored by the logged-in host user; null when that user could not be looked up. */
    isMine: boolean | null;
    /** An agent's review proposal for this PR (`tools hub proposal push`), when one is stored. */
    proposal: ProposalSummary | null;
}

export interface HubPrDetail extends HubPr, Omit<PrDetail, keyof PrSummary> {
    warnings: string[];
    /** Names in the description that are branches of the local checkout (none without one). */
    branchMentions: string[];
}

/** One project the paths resolved to. `error` set means its PRs are unknown, not absent. */
export interface HubPrRepo {
    /** Never null: the hub decodes it as a String (Hub/HubPRs.swift `HubPRList.Repo`). */
    repo: string;
    repoRoot: string | null;
    /** The input paths that resolved to this project. */
    paths: string[];
    origin: { kind: OriginKind | null; host: string | null; web: string | null } | null;
    count: number;
    error: string | null;
    warnings: string[];
}

export interface HubPrsResult {
    prs: HubPr[];
    repos: HubPrRepo[];
    /** Paths that are not inside a git checkout. */
    skipped: { path: string; reason: string }[];
}

const log = logger.child({ component: "review/prs" });

/** Branch name to worktree path; the main checkout loses a tie so a dedicated worktree wins. */
export function worktreeByBranch(worktrees: WorktreeInfo[]): Map<string, string> {
    const byBranch = new Map<string, string>();

    for (const wt of [...worktrees].sort((a, b) => Number(b.isMain) - Number(a.isMain))) {
        if (wt.branch && !wt.isBare) {
            byBranch.set(wt.branch, wt.path);
        }
    }

    return byBranch;
}

/** `<url>`, `<repoPath>#<number>`, or `<number>` / `#<number>` for the current folder's repo; null otherwise. */
export function parsePrRef(ref: string): { url: string } | { path: string; number: number } | null {
    const trimmed = ref.trim();

    if (/^https?:\/\//i.test(trimmed)) {
        return { url: trimmed };
    }

    const bare = /^#?(\d+)$/.exec(trimmed);

    if (bare) {
        return { path: process.cwd(), number: Number(bare[1]) };
    }

    const match = /^(.+)#(\d+)$/.exec(trimmed);
    return match ? { path: match[1], number: Number(match[2]) } : null;
}

function toHubPr({
    pr,
    project,
    repo,
    repoRoot,
    worktrees,
    viewer,
    mine,
}: {
    pr: PrSummary;
    project: ProjectRef;
    repo: string;
    repoRoot: string | null;
    worktrees: Map<string, string>;
    viewer: string | null;
    mine: boolean;
}): HubPr {
    const proposal = proposalFor({
        provider: project.kind,
        host: project.host,
        project: project.path,
        number: pr.number,
    });
    return {
        repo,
        repoRoot,
        origin: { kind: project.kind, host: project.host, web: project.web },
        ...pr,
        // A detached review worktree has no branch to match; the proposal names the checkout it read.
        localWorktree: worktrees.get(pr.headBranch) ?? proposal?.repoPath ?? null,
        isMine: mine ? true : viewer && pr.author ? viewer === pr.author : null,
        proposal,
    };
}

interface ProjectGroup {
    key: string;
    facts: RepoFacts[];
    paths: string[];
}

/** Paths that share an origin (worktrees, second clones) are one project. */
function groupByOrigin(facts: RepoFacts[]): { groups: ProjectGroup[]; skipped: HubPrsResult["skipped"] } {
    const groups = new Map<string, ProjectGroup>();
    const skipped: HubPrsResult["skipped"] = [];

    for (const fact of facts) {
        if (!fact.root) {
            skipped.push({ path: fact.path, reason: "not a git checkout" });
            continue;
        }

        const key = fact.origin?.web ?? fact.origin?.url ?? `local:${fact.repo ?? fact.root}`;
        const group = groups.get(key) ?? { key, facts: [], paths: [] };

        if (!group.paths.includes(fact.path)) {
            group.paths.push(fact.path);
            group.facts.push(fact);
        }

        groups.set(key, group);
    }

    return { groups: [...groups.values()], skipped };
}

async function localWorktrees(roots: string[]): Promise<{ all: WorktreeInfo[]; main: string | null }> {
    const lists = await Promise.all([...new Set(roots)].map((root) => listWorktrees(root)));
    const seen = new Set<string>();
    const all: WorktreeInfo[] = [];

    for (const wt of lists.flat()) {
        if (!seen.has(wt.path)) {
            seen.add(wt.path);
            all.push(wt);
        }
    }

    return { all, main: lists[0]?.find((wt) => wt.isMain)?.path ?? null };
}

/** One `viewerLogin` per host for the whole run. */
function viewerCache(runner: CommandRunner): (project: ProjectRef, cwd: string) => Promise<string | null> {
    const cache = new Map<string, Promise<string | null>>();

    return (project, cwd) => {
        const key = `${project.kind}:${project.host}`;
        let pending = cache.get(key);

        if (!pending) {
            pending = viewerLogin({ project, cwd, runner });
            cache.set(key, pending);
        }

        return pending;
    };
}

/**
 * PRs/MRs of every project among `paths`, one host query per project, four projects at a time.
 * Read-only. `updatedSince` keeps only PRs updated since then (`listPrs`).
 */
export async function hubPrs({
    paths,
    state = "open",
    mine = false,
    limit = 30,
    updatedSince,
    runner = spawnRunner,
}: {
    paths: string[];
    state?: PrListState;
    mine?: boolean;
    limit?: number;
    updatedSince?: Date;
    runner?: CommandRunner;
}): Promise<HubPrsResult> {
    const facts = await repoFactsMany({ paths });
    const { groups, skipped } = groupByOrigin(facts);
    const viewerFor = viewerCache(runner);
    log.debug(
        { paths: paths.length, projects: groups.length, skipped: skipped.length, state, mine, limit, updatedSince },
        "hub prs"
    );

    const results = await concurrentMap({
        items: groups,
        concurrency: 4,
        fn: async (group): Promise<{ repo: HubPrRepo; prs: HubPr[] }> => {
            const first = group.facts[0];
            const worktrees = await localWorktrees(group.facts.map((fact) => fact.root ?? fact.path));
            const repoRoot = worktrees.main ?? first.root;
            const repoName = first.repo ?? basename(repoRoot ?? first.path);
            const origin = first.origin
                ? { kind: first.origin.kind, host: first.origin.host, web: first.origin.web }
                : null;
            const entry: HubPrRepo = {
                repo: repoName,
                repoRoot,
                paths: group.paths,
                origin,
                count: 0,
                error: null,
                warnings: [],
            };
            const project = first.origin ? projectRefFromRemote(first.origin.url) : null;

            if (!project) {
                entry.error = first.origin
                    ? `no gh/glab driver for ${first.origin.host ?? first.origin.url}`
                    : "no origin remote";
                log.debug({ repo: repoName, error: entry.error }, "project skipped");
                return { repo: entry, prs: [] };
            }

            const cwd = repoRoot ?? first.path;
            const [listed, viewer] = await Promise.all([
                listPrs({ project, state, mine, limit, updatedSince, cwd, runner }),
                viewerFor(project, cwd),
            ]);
            const byBranch = worktreeByBranch(worktrees.all);
            entry.error = listed.error;
            entry.warnings = listed.warnings;
            entry.count = listed.prs.length;

            return {
                repo: entry,
                prs: listed.prs.map((pr) =>
                    toHubPr({ pr, project, repo: repoName, repoRoot, worktrees: byBranch, viewer, mine })
                ),
            };
        },
        onError: (group, err) => log.warn({ err, key: group.key }, "hub prs: project lookup threw"),
    });

    const repos: HubPrRepo[] = [];
    const prs: HubPr[] = [];

    for (const group of groups) {
        const result = results.get(group);

        if (result) {
            repos.push(result.repo);
            prs.push(...result.prs);
        } else {
            repos.push({
                repo: group.facts[0].repo ?? basename(group.facts[0].root ?? group.facts[0].path),
                repoRoot: group.facts[0].root,
                paths: group.paths,
                origin: null,
                count: 0,
                error: "lookup failed, see the log",
                warnings: [],
            });
        }
    }

    return { prs, repos, skipped };
}

export class PrRefError extends Error {}

/** One PR/MR by URL or `<repoPath>#<number>`, with body, commits and checks. Read-only; throws PrRefError. */
export async function hubPr({
    ref,
    runner = spawnRunner,
}: {
    ref: string;
    runner?: CommandRunner;
}): Promise<HubPrDetail> {
    const parsedRef = parsePrRef(ref);

    if (!parsedRef) {
        throw new PrRefError(`expected a PR/MR URL or <repoPath>#<number>, got "${ref}"`);
    }

    let project: ProjectRef;
    let number: number;
    let repo: string;
    let repoRoot: string | null = null;
    let worktrees = new Map<string, string>();

    if ("url" in parsedRef) {
        const fromUrl = parsePrUrl(parsedRef.url);

        if (!fromUrl) {
            throw new PrRefError(`not a GitHub PR or GitLab MR URL: ${parsedRef.url}`);
        }

        project = fromUrl.project;
        number = fromUrl.number;
        repo = basename(project.path);
    } else {
        const facts = await repoFacts({ path: parsedRef.path });

        if (!facts.root) {
            throw new PrRefError(`not a git checkout: ${parsedRef.path}`);
        }

        const fromOrigin = facts.origin ? projectRefFromRemote(facts.origin.url) : null;

        if (!fromOrigin) {
            throw new PrRefError(
                facts.origin ? `no gh/glab driver for ${facts.origin.host ?? facts.origin.url}` : "no origin remote"
            );
        }

        const local = await localWorktrees([facts.root]);
        project = fromOrigin;
        number = parsedRef.number;
        repoRoot = local.main ?? facts.root;
        repo = facts.repo ?? basename(repoRoot);
        worktrees = worktreeByBranch(local.all);
    }

    const cwd = repoRoot ?? process.cwd();
    const [viewed, viewer, branches] = await Promise.all([
        viewPr({ project, number, cwd, runner }),
        viewerLogin({ project, cwd, runner }),
        repoRoot ? localBranchNames(repoRoot) : Promise.resolve(new Set<string>()),
    ]);
    log.debug({ project: project.path, number, error: viewed.error, warnings: viewed.warnings }, "hub pr");

    if (!viewed.pr) {
        throw new PrRefError(viewed.error ?? "the host returned no PR");
    }

    return {
        ...toHubPr({ pr: viewed.pr, project, repo, repoRoot, worktrees, viewer, mine: false }),
        ...viewed.pr,
        warnings: viewed.warnings,
        branchMentions: branchMentions(viewed.pr.body, branches),
    };
}
