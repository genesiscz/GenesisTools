import type {
    PrChecksDto,
    PrFixInput,
    PrFixReceiptDto,
    PrMergeInput,
    PrMergeReceiptDto,
    PrTriageDto,
    PrTriageRowDto,
    PrTriageVerdict,
} from "@app/dev-dashboard/contract/agents";
import { execTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { checkLog } from "../checks";
import { fixCheck } from "../checks-fix";
import { type FixThreadsResult, fixThreads, realFixThreadsDeps } from "../fix-threads";
import { prReadinessMany, type ReadinessOutcome } from "../pr-readiness";
import { type HubPr, type HubPrsResult, hubPr, hubPrProjects, hubPrs } from "../prs";

const log = logger.child({ component: "hub/triage" });

/** How many lines of a failed step the phone shows. */
const FAILING_LINES = 40;
/** A merge restacks and pushes; it may take a while, but never forever. */
const MERGE_TIMEOUT_MS = 5 * 60_000;

/** The order the list shows: what can merge first, then what waits, then what is blocked. */
const VERDICT_ORDER: Record<PrTriageVerdict, number> = { ready: 0, waiting: 1, blocked: 2, closed: 3 };

export interface TriageDeps {
    projectPaths(): Promise<string[]>;
    list(input: { paths: string[]; mine: boolean; limit: number }): Promise<HubPrsResult>;
    readiness(inputs: string[]): Promise<ReadinessOutcome[]>;
    now(): Date;
}

export const realTriageDeps: TriageDeps = {
    projectPaths: async () => (await hubPrProjects()).map((project) => project.root),
    list: (input) => hubPrs({ ...input, state: "open" }),
    readiness: (inputs) => prReadinessMany({ inputs, maxCacheAgeSeconds: 120 }),
    now: () => new Date(),
};

function rowOf(pr: HubPr, outcome: ReadinessOutcome | undefined): PrTriageRowDto {
    const readiness = outcome?.readiness ?? null;
    return {
        url: pr.url,
        provider: pr.origin.kind === "gitlab" ? "gitlab" : "github",
        number: pr.number,
        title: pr.title,
        repo: pr.repo,
        checkout: pr.localWorktree ?? pr.repoRoot,
        author: pr.author,
        isMine: pr.isMine,
        draft: pr.draft,
        headBranch: pr.headBranch,
        ci: readiness?.ci ?? pr.ci,
        verdict: readiness?.verdict ?? null,
        summary: readiness?.summary ?? null,
        reasons: readiness?.reasons ?? [],
        unresolved: readiness?.unresolved ?? 0,
        mergeable: readiness?.mergeable ?? null,
        readinessError: outcome?.error ?? (readiness ? null : "no readiness read"),
        updatedAt: pr.updatedAt,
    };
}

/**
 * The phone's PR triage list (F20): the open PRs of every configured project, each with the hub's readiness verdict
 * (ready badge, unresolved threads, CI), ready ones first. Reads only; a project the host could not answer is listed
 * in `skipped`, so its PRs read as unknown, not absent.
 */
export async function prTriage(
    input: { mine?: boolean; limit?: number } = {},
    deps: TriageDeps = realTriageDeps
): Promise<PrTriageDto> {
    const paths = await deps.projectPaths();
    const listed = await deps.list({ paths, mine: input.mine ?? false, limit: input.limit ?? 30 });
    const inputs = listed.prs.map((pr) => (pr.headSha ? `${pr.url}@${pr.headSha}` : pr.url));
    const outcomes = await deps.readiness(inputs);
    const byInput = new Map(outcomes.map((outcome) => [outcome.input, outcome]));
    const prs = listed.prs
        .map((pr, index) => rowOf(pr, byInput.get(inputs[index] ?? "")))
        .sort(
            (a, b) =>
                (a.verdict ? VERDICT_ORDER[a.verdict] : 9) - (b.verdict ? VERDICT_ORDER[b.verdict] : 9) ||
                Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        );
    const skipped = [
        ...listed.repos
            .filter((repo) => repo.error)
            .map((repo) => ({ what: repo.repo, reason: repo.errorSummary ?? repo.error ?? "unreadable" })),
        ...listed.skipped.map((entry) => ({ what: entry.path, reason: entry.reason })),
    ];
    log.debug({ paths: paths.length, prs: prs.length, skipped: skipped.length }, "pr triage read");
    return { generatedAt: deps.now().toISOString(), prs, skipped };
}

/** A PR's checks and the tail of the first failed one's log: the failing step the phone shows. Reads only. */
export async function prChecks(input: { url: string }): Promise<PrChecksDto> {
    const detail = await hubPr({ ref: input.url, maxCacheAgeSeconds: 60 });
    const checks = detail.checks.map((check) => ({ name: check.name, status: check.status, url: check.url }));
    const failed = detail.checks.find((check) => check.status === "failed");

    if (!failed?.url) {
        return {
            url: input.url,
            checks,
            failing: failed ? { name: failed.name, url: null, lines: [], error: "the check has no log URL" } : null,
        };
    }

    const logRead = await checkLog({ url: failed.url, maxLines: FAILING_LINES });
    const section = logRead.sections[0];
    return {
        url: input.url,
        checks,
        failing: {
            name: section?.name ?? failed.name,
            url: failed.url,
            lines: section?.lines.slice(-FAILING_LINES) ?? [],
            error: logRead.error ?? null,
        },
    };
}

function fixReceipt(input: PrFixInput, result: FixThreadsResult | null, error: string | null): PrFixReceiptDto {
    return {
        url: input.url,
        kind: input.kind,
        sent: result?.sent ?? false,
        owner: result?.owner?.sessionId ?? null,
        file: result?.written ? result.file : null,
        error: error ?? result?.error ?? null,
    };
}

/**
 * "Fix with agent" (F20): the PR's unresolved, current threads, or one failed check, become a task file, and its
 * pointer line goes to the session that owns the PR (the hub's own PR fix and check fix, through the session-send
 * hand-off). Nothing is written to the PR, and no window is raised on the Mac.
 */
export async function fixPr(input: PrFixInput): Promise<PrFixReceiptDto> {
    try {
        if (input.kind === "check") {
            if (!input.checkUrl) {
                return fixReceipt(input, null, "a check fix needs the check's URL");
            }

            const result = await fixCheck({
                repo: input.checkout,
                pr: input.url,
                checkUrl: input.checkUrl,
                checkName: input.checkName ?? "check",
                focus: false,
                activate: false,
            });
            return fixReceipt(input, result, null);
        }

        const pr = await realFixThreadsDeps.pr({ repo: input.checkout, pr: input.url });
        const { threads } = await realFixThreadsDeps.threads(pr);
        const ids = threads.filter((thread) => !thread.resolved && !thread.outdated).map((thread) => thread.id);

        if (ids.length === 0) {
            return fixReceipt(input, null, "the PR has no unresolved, current review thread");
        }

        const result = await fixThreads(
            { repo: input.checkout, pr: input.url, ids, focus: false, activate: false },
            realFixThreadsDeps
        );
        return fixReceipt(input, result, null);
    } catch (err) {
        log.warn({ err, url: input.url, kind: input.kind }, "pr fix failed");
        return fixReceipt(input, null, err instanceof Error ? err.message : String(err));
    }
}

/** Runs one merge command; tests replace it, so no PR is merged. */
export type MergeRunner = (args: string[]) => Promise<{ success: boolean; stdout: string; stderr: string }>;

const realMergeRunner: MergeRunner = (args) => execTool(args, { timeout: MERGE_TIMEOUT_MS });

function lastLines(text: string, count = 6): string {
    return text.trim().split("\n").slice(-count).join("\n");
}

/**
 * Merge from the phone (F20): `tools github merge <url> --rebase|--squash`, the stack-safe merge every merge here goes
 * through (it retargets dependent PRs first). A GitLab MR is refused until `PrBackend` has a merge member.
 */
export async function mergePr(input: PrMergeInput, run: MergeRunner = realMergeRunner): Promise<PrMergeReceiptDto> {
    const receipt = (merged: boolean, detail: string): PrMergeReceiptDto => ({
        url: input.url,
        method: input.method,
        merged,
        detail,
    });

    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(input.url)) {
        return receipt(
            false,
            "only a github.com PR merges from the phone; a GitLab MR needs a PrBackend merge member first"
        );
    }

    const result = await run(["github", "merge", input.url, `--${input.method}`]);
    log.info({ url: input.url, method: input.method, ok: result.success }, "pr merge ran");
    return receipt(
        result.success,
        lastLines(result.success ? result.stdout || result.stderr : result.stderr || result.stdout)
    );
}
