import { createHash } from "node:crypto";
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
    type PrQuery,
    type PrSummary,
    parsePrRef,
    parsePrUrl,
    projectRefFromRemote,
    spawnRunner,
    viewerLogin,
    viewPr,
    type WorktreeInfo,
    worktreeByBranch,
} from "@genesiscz/utils/git";
import { branchMentions, localBranchNames } from "@genesiscz/utils/git/branch-names";
import { type RepoFacts, repoFacts, repoFactsMany } from "@genesiscz/utils/git/repo-facts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { cached } from "@genesiscz/utils/storage/cache-flag";
import { Storage } from "@genesiscz/utils/storage/storage";
import { type ProposalSummary, proposalFor } from "./proposal";

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
        isMine: viewer && pr.author ? viewer === pr.author : mine ? true : null,
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

function hubCache(): Storage {
    return new Storage("hub");
}

function cacheHash(value: unknown): string {
    return createHash("sha256").update(SafeJSON.stringify(value)).digest("hex").slice(0, 24);
}

/**
 * PRs/MRs of every project among `paths`, one host query per project, four projects at a time.
 * Read-only. `updatedSince` keeps only PRs updated since then, `query` searches the host (`listPrs`).
 * Fresh by default; `maxCacheAgeSeconds` serves a stored answer for the same projects and filters.
 */
export async function hubPrs({
    paths,
    state = "open",
    mine = false,
    limit = 30,
    updatedSince,
    query,
    maxCacheAgeSeconds,
    runner = spawnRunner,
    storage = hubCache(),
}: {
    paths: string[];
    state?: PrListState;
    mine?: boolean;
    limit?: number;
    updatedSince?: Date;
    query?: PrQuery | string;
    maxCacheAgeSeconds?: number;
    runner?: CommandRunner;
    storage?: Pick<Storage, "getCacheFile" | "putCacheFile">;
}): Promise<HubPrsResult> {
    const facts = await repoFactsMany({ paths });
    const { groups, skipped } = groupByOrigin(facts);
    const key = `pr-list/${cacheHash({
        groups: groups.map((group) => [group.key, group.paths]),
        skipped,
        state,
        mine,
        limit,
        updatedSince: updatedSince?.toISOString() ?? null,
        query: query ?? null,
    })}.json`;
    const { value, hit } = await cached({
        storage,
        key,
        maxAgeSeconds: maxCacheAgeSeconds,
        fetch: () => collectHubPrs({ groups, skipped, state, mine, limit, updatedSince, query, runner }),
        // A project whose lookup failed has unknown PRs, not none: the next call asks the host again.
        shouldStore: (result) => result.repos.every((repo) => repo.error === null),
    });
    log.debug({ key, hit, prs: value.prs.length }, "hub prs");
    return value;
}

async function collectHubPrs({
    groups,
    skipped,
    state,
    mine,
    limit,
    updatedSince,
    query,
    runner,
}: {
    groups: ProjectGroup[];
    skipped: HubPrsResult["skipped"];
    state: PrListState;
    mine: boolean;
    limit: number;
    updatedSince?: Date;
    query?: PrQuery | string;
    runner: CommandRunner;
}): Promise<HubPrsResult> {
    const viewerFor = viewerCache(runner);
    log.debug(
        {
            projects: groups.length,
            skipped: skipped.length,
            state,
            mine,
            limit,
            updatedSince,
            query,
        },
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
                listPrs({ project, state, mine, limit, updatedSince, query, cwd, runner }),
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
    maxCacheAgeSeconds,
    headSha,
    runner = spawnRunner,
    storage = hubCache(),
}: {
    ref: string;
    /** Serve a stored answer at most this old; fresh by default. */
    maxCacheAgeSeconds?: number;
    /** The head the caller knows: a stored answer for another head is not served. */
    headSha?: string;
    runner?: CommandRunner;
    storage?: Pick<Storage, "getCacheFile" | "putCacheFile">;
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

    const key = `pr-show/${cacheHash([project.kind, project.host, project.path, number, repoRoot])}.json`;
    const head = headSha?.trim().toLowerCase();
    const { value, hit } = await cached({
        storage,
        key,
        maxAgeSeconds: maxCacheAgeSeconds,
        isValid: (stored) => !head || Boolean(stored.headSha?.toLowerCase().startsWith(head)),
        fetch: () => fetchHubPr({ project, number, repo, repoRoot, worktrees, runner }),
    });
    log.debug({ key, hit, head }, "hub pr");
    return value;
}

async function fetchHubPr({
    project,
    number,
    repo,
    repoRoot,
    worktrees,
    runner,
}: {
    project: ProjectRef;
    number: number;
    repo: string;
    repoRoot: string | null;
    worktrees: Map<string, string>;
    runner: CommandRunner;
}): Promise<HubPrDetail> {
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
