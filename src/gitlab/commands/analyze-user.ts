/**
 * `gitlab analyze-user` — a user's contribution history across every project they pushed to,
 * since a date, as a day-by-day Markdown report or a JSON dump.
 *
 * Strategy: walk `/users/<id>/events` (which paginates reliably) to find every push, then
 * `compare(from..to)` to list the commits of each push. This avoids the GitLab bug where
 * `/projects/<id>/repository/commits?all=true` returns the same page for every `?page=N`.
 */

import { emit, positiveInt, progress, type TargetOptions, withHost } from "@app/gitlab/commands/shared";
import {
    compareCommits,
    findUser,
    type GitLabCommit,
    type GitLabProject,
    type GitLabUser,
    getCommit,
    getCommitDiff,
    getContributedProjects,
    getProject,
    getUserEvents,
    resolveApi,
} from "@app/gitlab/lib/client";
import { errorMessage } from "@app/gitlab/lib/http";
import { pool } from "@app/gitlab/lib/pool";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Command } from "commander";

interface EnrichedCommit extends GitLabCommit {
    project: GitLabProject;
    files: string[];
    branches: string[];
}

interface Options extends TargetOptions {
    user: string;
    since: string;
    output?: string;
    out?: string;
    json?: boolean;
    concurrency: string;
}

export function registerAnalyzeUser(parent: Command): Command {
    return withHost(
        parent
            .command("analyze-user")
            .description("Analyze a GitLab user's commit activity across all projects they contribute to")
            .requiredOption("--user <username>", "GitLab username")
            .requiredOption("--since <YYYY-MM-DD>", "Inclusive start date")
            .option("--output <path>", "Destination markdown/JSON file (default: stdout)")
            .option("--out <path>", "Alias of --output")
            .option("--json", "Emit raw JSON instead of a Markdown report")
            .option("--concurrency <N>", "Parallel fetches when enriching commits", "8")
    ).action(runAnalyzeUser);
}

type ShaRecord = { project: GitLabProject; sha: string; branch: string; pushTime: string };

async function runAnalyzeUser(opts: Options): Promise<void> {
    const outputPath = opts.output ?? opts.out;
    const concurrency = positiveInt(opts.concurrency, 8);
    const api = await resolveApi({ host: opts.host });

    progress(`Resolving user @${opts.user} on ${api.host}…`);
    const user = await findUser(api, opts.user);
    if (!user) {
        throw new Error(`No GitLab user found with username '${opts.user}'`);
    }

    progress(`  → ${user.name} (id=${user.id}, ${user.web_url})`);

    progress(`Fetching push events since ${opts.since}…`);
    const events = await getUserEvents(api, user.id, opts.since);
    const pushes = events.filter((e) => e.push_data?.commit_to);
    progress(`  → ${events.length} event(s), ${pushes.length} push(es)`);

    const projectsById = new Map<number, GitLabProject>();
    for (const p of await getContributedProjects(api, user.id)) {
        projectsById.set(p.id, p);
    }

    const missingProjectIds = [...new Set(pushes.map((e) => e.project_id))].filter((id) => !projectsById.has(id));
    if (missingProjectIds.length) {
        progress(`  Fetching ${missingProjectIds.length} project(s) not in /contributed_projects…`);

        await pool(missingProjectIds, 4, async (id) => {
            try {
                projectsById.set(id, await getProject(api, id));
            } catch (e) {
                progress(`    project ${id}: ${errorMessage(e)}`);
            }
        });
    }

    progress(`\nEnumerating commits from pushes (concurrency=${concurrency})…`);
    const shas: ShaRecord[] = [];

    await pool(pushes, concurrency, async (event) => {
        const project = projectsById.get(event.project_id);
        const pd = event.push_data;
        if (!project || !pd?.commit_to) {
            return;
        }

        // A single-commit push (or a branch created with one commit) needs no compare round-trip.
        if (pd.commit_count <= 1 || !pd.commit_from) {
            shas.push({ project, sha: pd.commit_to, branch: pd.ref, pushTime: event.created_at });

            return;
        }

        try {
            const commits = await compareCommits(api, {
                projectId: project.id,
                from: pd.commit_from,
                to: pd.commit_to,
            });
            for (const c of commits) {
                shas.push({ project, sha: c.id, branch: pd.ref, pushTime: event.created_at });
            }
        } catch (e) {
            progress(
                `  compare ${project.path_with_namespace} ${pd.commit_from.slice(0, 8)}..${pd.commit_to.slice(0, 8)}: ${errorMessage(e)}`
            );
            shas.push({ project, sha: pd.commit_to, branch: pd.ref, pushTime: event.created_at });
        }
    });

    // Keep the latest push's branch per (project, sha).
    const uniq = new Map<string, ShaRecord>();
    for (const r of shas) {
        const key = `${r.project.id}:${r.sha}`;
        const prev = uniq.get(key);

        if (!prev || prev.pushTime < r.pushTime) {
            uniq.set(key, r);
        }
    }

    progress(
        `  → ${uniq.size} unique commit(s) across ${new Set([...uniq.values()].map((r) => r.project.id)).size} project(s)`
    );

    progress("\nFetching commit details (stats + files)…");
    let done = 0;
    const raw = await pool([...uniq.values()], concurrency, async ({ project, sha, branch }) => {
        try {
            const [commit, diffs] = await Promise.all([
                getCommit(api, { projectId: project.id, sha }),
                getCommitDiff(api, project.id, sha).catch(() => []),
            ]);

            done++;
            if (done % 25 === 0) {
                progress(`  ${done}/${uniq.size}…`);
            }

            const files = diffs.map((d) => d.new_path || d.old_path).filter(Boolean);

            return { ...commit, project, files, branches: [branch] };
        } catch (e) {
            done++;
            progress(`  ${sha.slice(0, 8)}: ${errorMessage(e)}`);

            return null;
        }
    });

    const allFetched = raw.filter((c): c is EnrichedCommit => c !== null);

    // `/users/:id` hides the public email for most accounts, so the user's commit identities are
    // derived from the data: commits whose author name matches the handle or display name give
    // the emails, and every commit with one of those emails is kept. This catches commits
    // authored under a full name and a work email when the handle is something else entirely.
    const handle = user.username.toLowerCase();
    const displayName = user.name.toLowerCase();
    const userEmails = new Set<string>();

    for (const c of allFetched) {
        const name = (c.author_name ?? "").toLowerCase();
        const email = (c.author_email ?? "").toLowerCase();

        if (email && (name === handle || name === displayName || name.includes(handle))) {
            userEmails.add(email);
        }
    }

    if (!userEmails.size) {
        progress(
            `  WARN: no author_name matched '${user.username}' / '${user.name}' — keeping every discovered commit unfiltered.`
        );
    } else {
        progress(`  Identified author emails: ${[...userEmails].join(", ")}`);
    }

    const enriched = userEmails.size
        ? allFetched.filter((c) => userEmails.has((c.author_email ?? "").toLowerCase()))
        : allFetched;

    progress(`\n${enriched.length} authored commit(s) after filter`);

    const byDay = new Map<string, EnrichedCommit[]>();
    for (const c of enriched) {
        const key = c.authored_date.slice(0, 10);
        byDay.set(key, [...(byDay.get(key) ?? []), c]);
    }

    const days = [...byDay.keys()].sort().reverse();
    for (const day of days) {
        byDay.get(day)?.sort((a, b) => (a.authored_date < b.authored_date ? 1 : -1));
    }

    if (opts.json) {
        const payload = {
            user,
            since: opts.since,
            generatedAt: new Date().toISOString(),
            projects: [...new Set(enriched.map((c) => c.project.id))]
                .map((id) => projectsById.get(id))
                .filter((p): p is GitLabProject => Boolean(p)),
            commits: enriched,
        };
        emit(SafeJSON.stringify(payload, null, 2), outputPath, "JSON");

        return;
    }

    emit(renderMarkdown({ user, since: opts.since, enriched, byDay, days }), outputPath, "Markdown");
}

interface RenderArgs {
    user: GitLabUser;
    since: string;
    enriched: EnrichedCommit[];
    byDay: Map<string, EnrichedCommit[]>;
    days: string[];
}

function fmtTime(iso: string): string {
    return iso.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? iso;
}

function fmtCommitTitle(msg: string): string {
    return (msg.split("\n")[0] ?? "").trim().replace(/\|/g, "\\|");
}

function projectAnchor(p: GitLabProject): string {
    return `[${p.path_with_namespace}](${p.web_url})`;
}

const sumAdds = (cs: EnrichedCommit[]) => cs.reduce((a, c) => a + (c.stats?.additions ?? 0), 0);
const sumDels = (cs: EnrichedCommit[]) => cs.reduce((a, c) => a + (c.stats?.deletions ?? 0), 0);

function renderMarkdown({ user, since, enriched, byDay, days }: RenderArgs): string {
    const lines: string[] = [];

    lines.push(`# Analysis of ${user.name} (@${user.username})`);
    lines.push("");
    lines.push(`- GitLab user: [${user.web_url}](${user.web_url})`);
    lines.push(`- User ID: ${user.id}`);
    lines.push(`- Since: ${since}`);
    lines.push(`- Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
    lines.push("");

    const totalAdds = sumAdds(enriched);
    const totalDels = sumDels(enriched);

    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Total commits**: ${enriched.length}`);
    lines.push(`- **Total lines added**: ${totalAdds}`);
    lines.push(`- **Total lines removed**: ${totalDels}`);
    lines.push(`- **Net lines**: ${totalAdds - totalDels}`);
    lines.push(`- **Total file changes** (sum across commits): ${enriched.reduce((a, c) => a + c.files.length, 0)}`);
    lines.push(`- **Active days**: ${days.length}`);
    lines.push("");

    const perProject = new Map<string, { commits: number; adds: number; dels: number; project: GitLabProject }>();
    for (const c of enriched) {
        const key = c.project.path_with_namespace;
        const entry = perProject.get(key) ?? { commits: 0, adds: 0, dels: 0, project: c.project };
        entry.commits++;
        entry.adds += c.stats?.additions ?? 0;
        entry.dels += c.stats?.deletions ?? 0;
        perProject.set(key, entry);
    }

    lines.push("### Per-project totals");
    lines.push("");
    lines.push("| Project | Commits | Lines + | Lines − |");
    lines.push("|---|---:|---:|---:|");

    for (const entry of [...perProject.values()].sort((a, b) => b.commits - a.commits)) {
        lines.push(`| ${projectAnchor(entry.project)} | ${entry.commits} | ${entry.adds} | ${entry.dels} |`);
    }

    lines.push("");

    for (const day of days) {
        const dayCommits = byDay.get(day) ?? [];

        lines.push(`## ${day}`);
        lines.push("");
        lines.push(`_${dayCommits.length} commit(s), +${sumAdds(dayCommits)} −${sumDels(dayCommits)}_`);
        lines.push("");

        const byProject = new Map<string, EnrichedCommit[]>();
        for (const c of dayCommits) {
            const k = c.project.path_with_namespace;
            byProject.set(k, [...(byProject.get(k) ?? []), c]);
        }

        for (const cs of byProject.values()) {
            const proj = cs[0]?.project;
            if (!proj) {
                continue;
            }

            lines.push(`### ${projectAnchor(proj)} — ${cs.length} commit(s)`);
            lines.push("");

            for (const c of cs) {
                const branches = c.branches.length
                    ? c.branches.slice(0, 3).join(", ") + (c.branches.length > 3 ? ", …" : "")
                    : "(no branch ref)";

                lines.push(
                    `- [${fmtTime(c.authored_date)} \`${c.short_id}\` ${fmtCommitTitle(c.message)}](${c.web_url})`
                );
                lines.push(`  - Files changed: ${c.files.length}`);
                lines.push(`  - Lines changed: ${c.stats?.additions ?? 0} added, ${c.stats?.deletions ?? 0} removed`);
                lines.push(`  - Branch: ${branches}`);

                if (c.files.length) {
                    lines.push("  - Files:");

                    for (const f of c.files.slice(0, 50)) {
                        lines.push(`    - \`${f}\``);
                    }

                    if (c.files.length > 50) {
                        lines.push(`    - … (+${c.files.length - 50} more)`);
                    }
                }
            }

            lines.push("");
        }
    }

    return lines.join("\n");
}
