import { resolve } from "node:path";
import {
    type CommandRunner,
    type ProjectRef,
    type PrSummary,
    parseGhPrRows,
    parseGlabMrRows,
    parsePrUrl,
    projectRefFromRemote,
    spawnRunner,
    viewPr,
} from "@genesiscz/utils/git/origins";
import { GH_LIST_FIELDS } from "@genesiscz/utils/git/origins/prs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { parsePrRef } from "../prs";
import { type RepoFacts, repoFacts } from "../repo";
import { type FindResult, type FoundPr, HubPrError } from "./types";

const log = logger.child({ component: "hub/pr/find" });
const FIND_TIMEOUT_MS = 30_000;

/** Reads a checkout's branch and origin; injected in tests so they need no git repository. */
export type FactsReader = (options: { path: string }) => Promise<RepoFacts>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `sha` fields the shared row parsers drop, keyed by PR/MR number. */
function baseShas(json: string, provider: ProjectRef["kind"]): Map<number, string> {
    const byNumber = new Map<number, string>();
    const rows: unknown = SafeJSON.parse(json, { strict: true });

    for (const row of Array.isArray(rows) ? rows : []) {
        if (!isRecord(row)) {
            continue;
        }

        const number = provider === "github" ? row.number : row.iid;
        const refs = isRecord(row.diff_refs) ? row.diff_refs : null;
        const sha = provider === "github" ? row.baseRefOid : refs?.base_sha;

        if (typeof number === "number" && typeof sha === "string") {
            byNumber.set(number, sha);
        }
    }

    return byNumber;
}

/** Open first, then the most recently updated. */
function pickPr(prs: PrSummary[]): PrSummary | null {
    const sorted = [...prs].sort(
        (a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.updatedAt.localeCompare(a.updatedAt)
    );
    return sorted[0] ?? null;
}

async function runHost({
    cmd,
    cwd,
    runner,
}: {
    cmd: string[];
    cwd: string;
    runner: CommandRunner;
}): Promise<{ stdout: string; error: string | null }> {
    const res = await runner(cmd, { cwd, timeoutMs: FIND_TIMEOUT_MS });
    log.debug({ cmd, code: res.code }, "hub pr find: host query");

    if (res.code !== 0) {
        return { stdout: "", error: res.stderr.trim() || `${cmd[0]} exited ${res.code}` };
    }

    return { stdout: res.stdout, error: null };
}

/** PRs/MRs whose source branch is `branch`, in any state, through the logged-in gh / glab. */
async function prsForBranch({
    project,
    branch,
    cwd,
    runner,
}: {
    project: ProjectRef;
    branch: string;
    cwd: string;
    runner: CommandRunner;
}): Promise<{ prs: PrSummary[]; baseShas: Map<number, string>; error: string | null }> {
    const cmd =
        project.kind === "github"
            ? [
                  "gh",
                  "pr",
                  "list",
                  "--repo",
                  `${project.host}/${project.path}`,
                  "--head",
                  branch,
                  "--state",
                  "all",
                  "--limit",
                  "10",
                  "--json",
                  [...GH_LIST_FIELDS, "baseRefOid"].join(","),
              ]
            : [
                  "glab",
                  "api",
                  "--hostname",
                  project.host,
                  `projects/${encodeURIComponent(project.path)}/merge_requests?${new URLSearchParams({
                      source_branch: branch,
                      state: "all",
                      order_by: "updated_at",
                      sort: "desc",
                      per_page: "10",
                  })}`,
              ];
    const res = await runHost({ cmd, cwd, runner });

    if (res.error) {
        return { prs: [], baseShas: new Map(), error: res.error };
    }

    const prs = project.kind === "github" ? parseGhPrRows(res.stdout) : parseGlabMrRows(res.stdout);
    return { prs, baseShas: baseShas(res.stdout, project.kind), error: null };
}

/** GitLab lists leave out `diff_refs`; one GET of the chosen MR has them. */
async function gitlabBaseSha({
    project,
    number,
    cwd,
    runner,
}: {
    project: ProjectRef;
    number: number;
    cwd: string;
    runner: CommandRunner;
}): Promise<string | null> {
    const res = await runHost({
        cmd: [
            "glab",
            "api",
            "--hostname",
            project.host,
            `projects/${encodeURIComponent(project.path)}/merge_requests/${number}`,
        ],
        cwd,
        runner,
    });

    if (res.error) {
        log.debug({ number, error: res.error }, "hub pr find: MR detail failed; baseSha unknown");
        return null;
    }

    return baseShas(`[${res.stdout}]`, "gitlab").get(number) ?? null;
}

/**
 * The PR/MR whose source branch is the branch checked out at `repo`: open wins over merged or closed,
 * then the newest. `provider: null` with a reason when there is none, or when the branch or the
 * origin cannot have one. A host that cannot answer throws, because "unknown" is not "none". Read-only.
 */
export async function findBranchPr({
    repo,
    runner = spawnRunner,
    readFacts = repoFacts,
}: {
    repo: string;
    runner?: CommandRunner;
    readFacts?: FactsReader;
}): Promise<FindResult> {
    const repoPath = resolve(repo);
    const facts = await readFacts({ path: repoPath });
    const none = (reason: string): FindResult => {
        log.debug({ repoPath, branch: facts.branch, reason }, "hub pr find: none");
        return { provider: null, reason, branch: facts.branch, repoPath };
    };

    if (!facts.root) {
        return none("not a git checkout");
    }

    if (!facts.origin) {
        return none("no origin remote");
    }

    const project = projectRefFromRemote(facts.origin.url);

    if (!project) {
        return none(`origin ${facts.origin.host ?? facts.origin.url} is neither GitHub nor GitLab`);
    }

    if (!facts.branch) {
        return none("detached HEAD: no branch to match a PR/MR against");
    }

    const cwd = facts.root;
    const listed = await prsForBranch({ project, branch: facts.branch, cwd, runner });

    if (listed.error) {
        throw new HubPrError(
            "provider",
            `${project.kind === "github" ? "gh" : "glab"} could not list PRs: ${listed.error}`
        );
    }

    const pr = pickPr(listed.prs);

    if (!pr) {
        return none(`no ${project.kind === "github" ? "PR" : "MR"} has ${facts.branch} as its source branch`);
    }

    const baseSha =
        listed.baseShas.get(pr.number) ??
        (project.kind === "gitlab" ? await gitlabBaseSha({ project, number: pr.number, cwd, runner }) : null);
    const found: FoundPr = {
        provider: project.kind,
        host: project.host,
        project: project.path,
        number: pr.number,
        url: pr.url,
        webUrl: pr.url,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        author: pr.author,
        sourceBranch: pr.headBranch,
        targetBranch: pr.baseBranch,
        headSha: pr.headSha,
        baseSha,
        crossRepository: pr.crossRepository,
        headRepo: pr.headRepo,
        repoPath: facts.root,
    };
    log.debug({ provider: found.provider, project: found.project, number: found.number }, "hub pr find");
    return found;
}

/**
 * A PR/MR named by its URL or `<repoPath>#<number>`, for a review that is not the checked-out branch
 * (a detached review worktree). Read-only; `not-found` when the host has no such PR/MR.
 */
export async function findPrByRef({
    ref,
    runner = spawnRunner,
    readFacts = repoFacts,
}: {
    ref: string;
    runner?: CommandRunner;
    readFacts?: FactsReader;
}): Promise<FoundPr> {
    const parsed = parsePrRef(ref);

    if (!parsed) {
        throw new HubPrError("bad-input", `--pr takes a PR/MR URL or <repoPath>#<number>, got "${ref}"`);
    }

    let project: ProjectRef | null;
    let number: number;
    let repoPath: string | null = null;

    if ("url" in parsed) {
        const fromUrl = parsePrUrl(parsed.url);
        project = fromUrl?.project ?? null;
        number = fromUrl?.number ?? 0;
    } else {
        const facts = await readFacts({ path: resolve(parsed.path) });
        project = facts.origin ? projectRefFromRemote(facts.origin.url) : null;
        number = parsed.number;
        repoPath = facts.root;
    }

    if (!project) {
        throw new HubPrError("bad-input", `${ref} is not a GitHub PR or GitLab MR`);
    }

    const viewed = await viewPr({ project, number, cwd: repoPath ?? process.cwd(), runner });

    if (!viewed.pr) {
        throw new HubPrError("not-found", viewed.error ?? `no PR/MR ${project.path}#${number}`);
    }

    const pr = viewed.pr;
    log.debug({ provider: project.kind, project: project.path, number }, "hub pr find by ref");
    return {
        provider: project.kind,
        host: project.host,
        project: project.path,
        number: pr.number,
        url: pr.url,
        webUrl: pr.url,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        author: pr.author,
        sourceBranch: pr.headBranch,
        targetBranch: pr.baseBranch,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        crossRepository: pr.crossRepository,
        headRepo: pr.headRepo,
        repoPath,
    };
}
