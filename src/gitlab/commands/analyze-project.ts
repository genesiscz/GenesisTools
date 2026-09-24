/**
 * `gitlab analyze-project` — per-project activity report grouped by month, plus a maintainer
 * leaderboard. Terser than `analyze-user`.
 *
 * Strategy: walk every branch with `?ref_name=<branch>&since=<date>&with_stats=true` and
 * deduplicate by SHA, avoiding the `?all=true` pagination bug (the same page for every `?page=N`).
 */

import { emit, positiveInt, progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import {
    type GitLabCommit,
    type GitLabProject,
    getCommitDiff,
    getProject,
    getProjectCommitsInRange,
    resolveProjectApi,
} from "@app/gitlab/lib/client";
import { errorMessage } from "@app/gitlab/lib/http";
import { pool } from "@app/gitlab/lib/pool";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Command } from "commander";

interface EnrichedCommit extends GitLabCommit {
    fileCount: number;
}

interface Options extends TargetOptions {
    since: string;
    until?: string;
    output?: string;
    out?: string;
    json?: boolean;
    concurrency: string;
    branchConcurrency: string;
}

export function registerAnalyzeProject(parent: Command): Command {
    return withProject(
        parent
            .command("analyze-project")
            .description("Per-project commit activity grouped by month + maintainer leaderboard")
            .requiredOption("--since <YYYY-MM-DD>", "Inclusive start date")
            .option("--until <YYYY-MM-DD>", "Exclusive end date (default: now)")
            .option("--output <path>", "Destination markdown/JSON file (default: stdout)")
            .option("--out <path>", "Alias of --output")
            .option("--json", "Emit raw JSON instead of a Markdown report")
            .option("--concurrency <N>", "Parallel diff fetches when counting files per commit", "8")
            .option("--branch-concurrency <N>", "Parallel branch walks when enumerating commits", "6")
    ).action(runAnalyzeProject);
}

async function runAnalyzeProject(opts: Options): Promise<void> {
    const outputPath = opts.output ?? opts.out;
    const diffConcurrency = positiveInt(opts.concurrency, 8);
    const branchConcurrency = positiveInt(opts.branchConcurrency, 6);
    const sinceIso = `${opts.since}T00:00:00Z`;
    const untilIso = opts.until ? `${opts.until}T00:00:00Z` : null;
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });

    progress(`Resolving project '${api.project}'…`);
    const project = await getProject(api, api.project);
    progress(`  → ${project.path_with_namespace} (id=${project.id}, default=${project.default_branch})`);

    progress(
        `Walking branches (concurrency=${branchConcurrency}), since=${opts.since}${opts.until ? `, until=${opts.until}` : ""}…`
    );
    const commits = await getProjectCommitsInRange(api, {
        projectId: project.id,
        sinceIso,
        untilIso,
        concurrency: branchConcurrency,
    });
    progress(`  → ${commits.length} unique commit(s)`);

    progress(`Fetching per-commit diffs (concurrency=${diffConcurrency})…`);
    let done = 0;
    const enriched: EnrichedCommit[] = await pool(commits, diffConcurrency, async (c) => {
        let fileCount = 0;

        try {
            fileCount = (await getCommitDiff(api, project.id, c.id)).length;
        } catch (e) {
            progress(`  ${c.short_id}: diff error ${errorMessage(e)}`);
        }

        done++;
        if (done % 50 === 0) {
            progress(`  ${done}/${commits.length}…`);
        }

        return { ...c, fileCount };
    });

    if (opts.json) {
        const payload = {
            project,
            since: opts.since,
            until: opts.until ?? null,
            generatedAt: new Date().toISOString(),
            commits: enriched,
        };
        emit(SafeJSON.stringify(payload, null, 2), outputPath, "JSON");

        return;
    }

    emit(renderMarkdown({ project, since: opts.since, until: opts.until, commits: enriched }), outputPath, "Markdown");
}

function fmtTitle(msg: string): string {
    return (msg.split("\n")[0] ?? "").trim().replace(/\|/g, "\\|");
}

const sumAdds = (cs: GitLabCommit[]) => cs.reduce((a, c) => a + (c.stats?.additions ?? 0), 0);
const sumDels = (cs: GitLabCommit[]) => cs.reduce((a, c) => a + (c.stats?.deletions ?? 0), 0);

function renderMarkdown(args: {
    project: GitLabProject;
    since: string;
    until: string | undefined;
    commits: EnrichedCommit[];
}): string {
    const { project, since, until, commits } = args;
    const lines: string[] = [];

    lines.push(`# ${project.name_with_namespace}`);
    lines.push("");
    lines.push(`- Repo: [${project.web_url}](${project.web_url})`);
    lines.push(`- Default branch: \`${project.default_branch}\``);
    lines.push(`- Window: ${since}${until ? ` → ${until}` : " → today"}`);
    lines.push(`- Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
    lines.push("");

    const adds = sumAdds(commits);
    const dels = sumDels(commits);

    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Total commits**: ${commits.length}`);
    lines.push(`- **Lines added**: ${adds}`);
    lines.push(`- **Lines removed**: ${dels}`);
    lines.push(`- **Net lines**: ${adds - dels}`);
    lines.push("");

    const byAuthor = new Map<string, { name: string; email: string; commits: number; adds: number; dels: number }>();
    for (const c of commits) {
        const email = c.author_email ?? "(unknown)";
        const entry = byAuthor.get(email) ?? { name: c.author_name, email, commits: 0, adds: 0, dels: 0 };
        entry.commits++;
        entry.adds += c.stats?.additions ?? 0;
        entry.dels += c.stats?.deletions ?? 0;
        byAuthor.set(email, entry);
    }

    lines.push("## Maintainers");
    lines.push("");
    lines.push("| Author | Email | Commits | Lines + | Lines − |");
    lines.push("|---|---|---:|---:|---:|");

    for (const entry of [...byAuthor.values()].sort((a, b) => b.commits - a.commits)) {
        lines.push(`| ${entry.name} | ${entry.email} | ${entry.commits} | ${entry.adds} | ${entry.dels} |`);
    }

    lines.push("");

    const byMonth = new Map<string, EnrichedCommit[]>();
    for (const c of commits) {
        const k = c.authored_date.slice(0, 7);
        byMonth.set(k, [...(byMonth.get(k) ?? []), c]);
    }

    for (const month of [...byMonth.keys()].sort().reverse()) {
        const ms = (byMonth.get(month) ?? []).sort((a, b) => (a.authored_date < b.authored_date ? 1 : -1));

        lines.push(`## Commits for ${month}`);
        lines.push("");
        lines.push(`_${ms.length} commit(s), +${sumAdds(ms)} −${sumDels(ms)}_`);
        lines.push("");

        for (const c of ms) {
            lines.push(
                `- [(${c.short_id}) ${fmtTitle(c.message)}](${c.web_url}) — Added ${c.stats?.additions ?? 0} lines, Removed ${c.stats?.deletions ?? 0} lines, changed ${c.fileCount} files`
            );
        }

        lines.push("");
    }

    return lines.join("\n");
}
