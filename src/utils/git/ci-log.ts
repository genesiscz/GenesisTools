import { stripAnsi } from "@genesiscz/utils/string";

// CI log parsing: a GitHub Actions or GitLab check URL, GitHub's `gh run view --job --log` rows sliced
// to the failed steps, and a GitLab job trace. Pure text in, text out; fetching and caching are the caller's.

const MAX_LINE_CHARS = 500;
const MAX_ERROR_LINES = 20;

export type CheckLogTarget =
    | { provider: "github"; host: string; repo: string; runId: number; jobId: number | null }
    | { provider: "gitlab"; host: string; project: string; pipelineId: number | null; jobId: number | null };

/** A GitHub Actions run/job URL or a GitLab pipeline/job URL; null for anything else (a bot's status page). */
export function parseCheckUrl(url: string): CheckLogTarget | null {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const github = path.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?$/);

    if (github) {
        return {
            provider: "github",
            host: parsed.host,
            repo: `${github[1]}/${github[2]}`,
            runId: Number(github[3]),
            jobId: github[4] ? Number(github[4]) : null,
        };
    }

    const gitlab = path.match(/^\/(.+?)\/-\/(pipelines|jobs)\/(\d+)$/);

    if (gitlab) {
        const id = Number(gitlab[3]);
        return {
            provider: "gitlab",
            host: parsed.host,
            project: gitlab[1],
            pipelineId: gitlab[2] === "pipelines" ? id : null,
            jobId: gitlab[2] === "jobs" ? id : null,
        };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Line cleaning
// ---------------------------------------------------------------------------

const GH_LINE = /^﻿?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/;

/** One log line for display: no ANSI, GitHub's group markers as plain text, bounded length. */
export function cleanLine(raw: string): string | null {
    // gh prints a log's escape sequences in caret notation (`^[[36;1m`) rather than raw.
    let line = stripAnsi(raw)
        .replace(/\^\[\[[0-9;]*[A-Za-z]/g, "")
        .replace(/﻿/g, "");
    // A carriage return redraws the line in a terminal (progress bars); only the last draw shows.
    const cr = line.lastIndexOf("\r");

    if (cr >= 0) {
        line = line.slice(cr + 1);
    }

    if (line.startsWith("##[endgroup]")) {
        return null;
    }

    line = line.replace(/^##\[group\]/, "▸ ");

    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** The last `max` lines. */
export function tailLines(lines: string[], max: number): string[] {
    return lines.length > max ? lines.slice(lines.length - max) : lines;
}

export interface TimedLine {
    at: number | null;
    text: string;
}

/**
 * `gh run view --job <id> --log` rows (`job<TAB>step<TAB><timestamp> text`) or the raw API log
 * (`<timestamp> text`) into timed lines. gh names every step `UNKNOWN STEP` for current runners,
 * so the step comes from the job's step timestamps instead of the prefix.
 */
export function parseGithubLog(text: string): TimedLine[] {
    const lines: TimedLine[] = [];

    for (const row of text.split("\n")) {
        const fields = row.split("\t");
        const body = fields.length >= 3 ? fields.slice(2).join("\t") : row;
        const match = body.match(GH_LINE);
        const at = match ? Date.parse(match[1]) : Number.NaN;
        const cleaned = cleanLine(match ? match[2] : body);

        if (cleaned === null || (cleaned === "" && !match)) {
            continue;
        }

        lines.push({ at: Number.isFinite(at) ? at : null, text: cleaned });
    }

    return lines;
}

export interface GithubStep {
    number: number;
    name: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
}

/** The step and job conclusions GitHub gives a run that did not pass. */
export const GH_FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

function isRunnerCleanup(text: string): boolean {
    return text === "Post job cleanup." || text.startsWith("Cleaning up orphan processes");
}

/**
 * The failed steps' lines, each cut to its last `maxLines`. A step's window runs from its start to
 * one second after its end, because the API reports step times in whole seconds while log lines
 * carry sub-second stamps. With no failed step (a cancelled or timed-out job) the whole log before
 * the runner's cleanup is the section.
 */
export function sliceFailedSteps({
    lines,
    steps,
    jobName,
    maxLines,
}: {
    lines: TimedLine[];
    steps: GithubStep[];
    jobName: string;
    maxLines: number;
}): Array<{ name: string; lines: string[]; totalLines: number }> {
    const failed = steps.filter((step) => step.conclusion && GH_FAILED_CONCLUSIONS.has(step.conclusion));
    const sections: Array<{ name: string; lines: string[]; totalLines: number }> = [];

    for (const step of failed) {
        const start = step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
        const end = step.completedAt ? Date.parse(step.completedAt) + 1000 : Number.NaN;

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            continue;
        }

        const window = lines.filter((line) => line.at !== null && line.at >= start && line.at < end).map((l) => l.text);
        // The runner's post steps often share the failed step's last second; they are never the failure.
        const post = window.findIndex((text) => isRunnerCleanup(text));
        const inside = post >= 0 ? window.slice(0, post) : window;

        if (inside.length > 0) {
            sections.push({
                name: `${jobName} / ${step.name}`,
                lines: tailLines(inside, maxLines),
                totalLines: inside.length,
            });
        }
    }

    if (sections.length > 0) {
        return sections;
    }

    const cleanup = lines.findIndex((line) => isRunnerCleanup(line.text));
    const body = (cleanup > 0 ? lines.slice(0, cleanup) : lines).map((line) => line.text);
    return body.length > 0 ? [{ name: jobName, lines: tailLines(body, maxLines), totalLines: body.length }] : [];
}

/** GitHub's `##[error]` lines, which name the failure in one sentence. */
export function errorAnnotations(lines: TimedLine[]): string[] {
    const found = lines
        .map((line) => line.text)
        .filter((text) => text.startsWith("##[error]"))
        .map((text) => text.slice("##[error]".length).trim());
    return tailLines([...new Set(found)], MAX_ERROR_LINES);
}

/** A GitLab trace: section markers, ANSI and carriage-return redraws removed. */
export function parseGitlabTrace(text: string): string[] {
    const lines = text
        // biome-ignore lint/suspicious/noControlCharactersInRegex: GitLab's section markers end in an ANSI erase
        .replace(/section_(?:start|end):\d+:[^\r\n]*?\r?\u001b\[0K/g, "")
        .split("\n")
        .map(cleanLine)
        .filter((line): line is string => line !== null);

    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
    }

    return lines;
}
