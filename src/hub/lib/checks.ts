import { createHash } from "node:crypto";
import { type CommandRunner, spawnRunner } from "@genesiscz/utils/git";
import {
    type CheckLogTarget,
    errorAnnotations,
    GH_FAILED_CONCLUSIONS,
    type GithubStep,
    parseCheckUrl,
    parseGithubLog,
    parseGitlabTrace,
    sliceFailedSteps,
    tailLines,
} from "@genesiscz/utils/git/ci-log";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

// The failing part of a CI check's log, for the PR detail's Checks section: a GitHub Actions job
// (`gh run view --job --log` sliced to the failed steps) or a GitLab job trace. Fetched on demand
// and cached once every job in it has finished, since a finished job's log never changes.

const log = logger.child({ component: "hub/checks" });

const LOG_TIMEOUT_MS = 90_000;
const CACHE_TTL = "7 days";
/** A run or pipeline URL can name dozens of jobs; only the first failed ones are fetched. */
const MAX_JOBS = 3;
export const DEFAULT_LOG_LINES = 150;

export interface CheckLogSection {
    /** Job name, with the failed step after a slash on GitHub: `test (ubuntu) / Run tests`. */
    name: string;
    url: string | null;
    /** The host's word: `failure`, `failed`, `cancelled`, `in_progress`, … */
    status: string | null;
    /** The tail of the section, oldest first. */
    lines: string[];
    /** Lines the section had before the tail was cut. */
    totalLines: number;
}

export interface CheckLogResult {
    url: string;
    provider: "github" | "gitlab" | null;
    sections: CheckLogSection[];
    /** GitHub's `##[error]` annotations from anywhere in the log, the fastest summary of a failure. */
    errors: string[];
    /** Every job had finished, so the log is final (and was cached). */
    final: boolean;
    cached: boolean;
    fetchedAt: string;
    elapsedMs: number;
    /** Why there is no log: a check that is not a CI job, a host error, a job that never started. */
    error: string | null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function run(runner: CommandRunner, cmd: string[]): Promise<string> {
    log.debug({ cmd }, "check log query");
    const res = await runner(cmd, { cwd: process.cwd(), timeoutMs: LOG_TIMEOUT_MS });

    if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `${cmd[0]} exited ${res.code}`);
    }

    return res.stdout;
}

async function runJson(runner: CommandRunner, cmd: string[]): Promise<unknown> {
    return SafeJSON.parse(await run(runner, cmd), { strict: true });
}

function ghApi(host: string, endpoint: string): string[] {
    return ["gh", "api", "--hostname", host, endpoint];
}

function ghRepoArg(host: string, repo: string): string {
    return host === "github.com" ? repo : `${host}/${repo}`;
}

async function githubJob({
    target,
    jobId,
    maxLines,
    runner,
}: {
    target: Extract<CheckLogTarget, { provider: "github" }>;
    jobId: number;
    maxLines: number;
    runner: CommandRunner;
}): Promise<{ sections: CheckLogSection[]; errors: string[]; final: boolean }> {
    const job = await runJson(runner, ghApi(target.host, `repos/${target.repo}/actions/jobs/${jobId}`));

    if (!isRecord(job)) {
        throw new Error("gh returned no job");
    }

    const name = str(job.name) ?? `job ${jobId}`;
    const url = str(job.html_url);
    const status = str(job.conclusion) ?? str(job.status);
    const final = str(job.status) === "completed";
    const text = await run(runner, [
        "gh",
        "run",
        "view",
        "--job",
        String(jobId),
        "--log",
        "-R",
        ghRepoArg(target.host, target.repo),
    ]);
    const lines = parseGithubLog(text);
    const steps: GithubStep[] = records(job.steps).map((step) => ({
        number: typeof step.number === "number" ? step.number : 0,
        name: str(step.name) ?? "step",
        conclusion: str(step.conclusion),
        startedAt: str(step.started_at),
        completedAt: str(step.completed_at),
    }));
    const sections = sliceFailedSteps({ lines, steps, jobName: name, maxLines }).map((section) => ({
        ...section,
        url,
        status,
    }));
    return { sections, errors: errorAnnotations(lines), final };
}

async function githubLog(
    target: Extract<CheckLogTarget, { provider: "github" }>,
    maxLines: number,
    runner: CommandRunner
): Promise<{ sections: CheckLogSection[]; errors: string[]; final: boolean }> {
    if (target.jobId !== null) {
        return githubJob({ target, jobId: target.jobId, maxLines, runner });
    }

    const jobs = await runJson(
        runner,
        ghApi(target.host, `repos/${target.repo}/actions/runs/${target.runId}/jobs?filter=latest&per_page=100`)
    );
    const all = isRecord(jobs) ? records(jobs.jobs) : [];
    const failed = all.filter((job) => GH_FAILED_CONCLUSIONS.has(str(job.conclusion) ?? "")).slice(0, MAX_JOBS);
    const results = [];

    for (const job of failed) {
        if (typeof job.id === "number") {
            results.push(await githubJob({ target, jobId: job.id, maxLines, runner }));
        }
    }

    return {
        sections: results.flatMap((r) => r.sections),
        errors: [...new Set(results.flatMap((r) => r.errors))],
        final: all.every((job) => str(job.status) === "completed"),
    };
}

const GITLAB_DONE = new Set(["success", "failed", "canceled", "skipped", "manual"]);

async function gitlabLog(
    target: Extract<CheckLogTarget, { provider: "gitlab" }>,
    maxLines: number,
    runner: CommandRunner
): Promise<{ sections: CheckLogSection[]; errors: string[]; final: boolean }> {
    const project = `projects/${encodeURIComponent(target.project)}`;
    const api = (endpoint: string) => ["glab", "api", "--hostname", target.host, `${project}/${endpoint}`];
    let jobs: Record<string, unknown>[];
    // The failed jobs of a pipeline are all done by definition, so they cannot say whether others
    // still run: the pipeline's own status decides whether this log may be cached as final.
    let pipelineDone = true;

    if (target.jobId !== null) {
        const job = await runJson(runner, api(`jobs/${target.jobId}`));
        jobs = isRecord(job) ? [job] : [];
    } else {
        jobs = records(
            await runJson(runner, api(`pipelines/${target.pipelineId}/jobs?scope%5B%5D=failed&per_page=20`))
        );
        const pipeline = await runJson(runner, api(`pipelines/${target.pipelineId}`));
        pipelineDone = isRecord(pipeline) && GITLAB_DONE.has(str(pipeline.status) ?? "");
    }

    const sections: CheckLogSection[] = [];

    for (const job of jobs.slice(0, MAX_JOBS)) {
        if (typeof job.id !== "number") {
            continue;
        }

        const lines = parseGitlabTrace(await run(runner, api(`jobs/${job.id}/trace`)));
        sections.push({
            name: [str(job.stage), str(job.name)].filter(Boolean).join(" / ") || `job ${job.id}`,
            url: str(job.web_url),
            status: str(job.status),
            lines: tailLines(lines, maxLines),
            totalLines: lines.length,
        });
    }

    return {
        sections,
        errors: [],
        final: pipelineDone && jobs.every((job) => GITLAB_DONE.has(str(job.status) ?? "")),
    };
}

function cacheKey(url: string, maxLines: number): string {
    return `check-logs/${createHash("sha256").update(`${url}\n${maxLines}`).digest("hex").slice(0, 24)}.json`;
}

/**
 * The failing log of the check at `url`. A finished log is cached for a week under
 * `~/.genesis-tools/hub/cache/check-logs/`; `fresh` skips the read. Never throws: a check with no
 * CI log behind it, or a host error, comes back with `error` set.
 */
export async function checkLog({
    url,
    maxLines = DEFAULT_LOG_LINES,
    fresh = false,
    runner = spawnRunner,
    storage = new Storage("hub"),
}: {
    url: string;
    maxLines?: number;
    fresh?: boolean;
    runner?: CommandRunner;
    storage?: Storage;
}): Promise<CheckLogResult> {
    const started = performance.now();
    const key = cacheKey(url, maxLines);

    if (!fresh) {
        const hit = await storage.getCacheFile<CheckLogResult>(key, CACHE_TTL);

        if (hit) {
            log.debug({ url }, "check log cache hit");
            return { ...hit, cached: true, elapsedMs: Math.round(performance.now() - started) };
        }
    }

    const target = parseCheckUrl(url);
    const base: CheckLogResult = {
        url,
        provider: target?.provider ?? null,
        sections: [],
        errors: [],
        final: false,
        cached: false,
        fetchedAt: new Date().toISOString(),
        elapsedMs: 0,
        error: null,
    };

    if (!target) {
        return { ...base, error: "not a GitHub Actions or GitLab CI job: open the check's page for its details" };
    }

    try {
        const found =
            target.provider === "github"
                ? await githubLog(target, maxLines, runner)
                : await gitlabLog(target, maxLines, runner);
        const result: CheckLogResult = {
            ...base,
            ...found,
            error: found.sections.length === 0 && found.errors.length === 0 ? "the job has no failed log lines" : null,
            elapsedMs: Math.round(performance.now() - started),
        };
        log.info(
            {
                url,
                sections: result.sections.length,
                errors: result.errors.length,
                final: result.final,
                ms: result.elapsedMs,
            },
            "check log fetched"
        );

        if (result.final && result.error === null) {
            await storage.putCacheFile(key, result, CACHE_TTL);
        }

        return result;
    } catch (err) {
        log.warn({ err, url }, "check log failed");
        return {
            ...base,
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Math.round(performance.now() - started),
        };
    }
}

/**
 * The task file "Send to agent" writes: which check failed on which PR, the error annotations, then
 * each failed section's tail. Only a one-line prompt naming this file is typed into the session.
 */
export function checkFixMarkdown({
    checkName,
    prLabel,
    prUrl,
    branch,
    result,
}: {
    checkName: string;
    prLabel: string;
    prUrl: string;
    branch: string;
    result: CheckLogResult;
}): string {
    const lines = [
        `# CI check failed: ${checkName}`,
        "",
        `- PR: ${prLabel} ${prUrl}`,
        `- Branch: ${branch}`,
        `- Check: ${result.url}`,
        "",
        "Find the cause from the log below, fix it on this branch, run the same check locally where you can, then commit and push.",
        "Do not post, approve or merge anything on the PR.",
    ];

    if (result.errors.length > 0) {
        lines.push("", "## Errors", "", ...result.errors.map((line) => `- ${line}`));
    }

    for (const section of result.sections) {
        const cut =
            section.totalLines > section.lines.length
                ? ` (last ${section.lines.length} of ${section.totalLines} lines)`
                : "";
        lines.push("", `## ${section.name}${cut}`, "", "```", ...section.lines, "```");
    }

    if (result.error) {
        lines.push("", `No log: ${result.error}`);
    }

    return `${lines.join("\n")}\n`;
}

/** One line, so nothing multi-line is typed into the agent's prompt. */
export function checkFixPrompt({
    file,
    checkName,
    prLabel,
}: {
    file: string;
    checkName: string;
    prLabel: string;
}): string {
    return `The CI check "${checkName}" failed on ${prLabel}; its failing log is in ${file}: read that file, fix the cause on this branch and push.`;
}
