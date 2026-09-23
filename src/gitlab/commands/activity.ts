/**
 * `gitlab activity` — what a user did on GitLab, per local day: comments per merge request, pushes
 * per branch with commit counts, approvals, merges, opened MRs.
 *
 *   tools gitlab activity --from 2026-09-16 --to 2026-09-22
 *   tools gitlab activity --user alice --days 7 --detail
 *   tools gitlab activity --from 2026-09-01 --to 2026-09-30 --format json > sept.json
 *
 * stderr always states how many events were fetched and how many fell in the range, so an empty
 * day can be told apart from a failed or truncated fetch.
 */

import { writeFileSync } from "node:fs";
import { progress, type TargetOptions, withHost } from "@app/gitlab/commands/shared";
import {
    type ActivityEvent,
    apiWindow,
    buildReport,
    localDay,
    parseDay,
    renderMarkdown,
    renderText,
    shiftDay,
} from "@app/gitlab/lib/activity";
import { currentUser, findUser, getProject, resolveApi, restGetPage } from "@app/gitlab/lib/client";
import { errorMessage } from "@app/gitlab/lib/http";
import { fetchAllPages } from "@app/gitlab/lib/paginate";
import { pool } from "@app/gitlab/lib/pool";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Options extends Pick<TargetOptions, "host"> {
    user?: string;
    from?: string;
    to?: string;
    days?: string;
    project?: string;
    action?: string;
    targetType?: string;
    tz?: string;
    format: string;
    detail?: boolean;
    maxPages: string;
    output?: string;
}

const PER_PAGE = 100;
const FORMATS = ["text", "md", "json"];

export function registerActivity(parent: Command): Command {
    return withHost(
        parent
            .command("activity")
            .description("A user's GitLab events grouped per local day (comments, pushes, approvals, merges)")
            .option("--user <username>", "GitLab username (default: the token's owner)")
            .option("--from <YYYY-MM-DD>", "First local day, inclusive")
            .option("--to <YYYY-MM-DD>", "Last local day, inclusive (default: today)")
            .option("--days <N>", "Range length ending at --to when --from is omitted", "7")
            .option("--project <path-or-id>", "Keep only one project (a filter; events of every project are read)")
            .option("--action <name>", "Server-side filter: approved, closed, commented, created, merged, pushed, …")
            .option("--target-type <type>", "Server-side filter: merge_request, note, issue, …")
            .option("--tz <zone>", "Time zone for days and times (default: the system zone)")
            .option("--format <format>", "text | md | json", "text")
            .option("--detail", "Add a per-event timeline under each day")
            .option("--max-pages <N>", "Stop after N pages of 100 events and report truncation", "50")
            .option("--output <path>", "Write the rendered report to a file instead of stdout")
    ).action(runActivity);
}

async function runActivity(opts: Options): Promise<void> {
    const tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const to = parseDay(opts.to ?? localDay(new Date().toISOString(), tz), "--to");
    const span = Number(opts.days);

    if (!opts.from && (!Number.isInteger(span) || span < 1)) {
        throw new Error(`--days must be a positive whole number, got '${opts.days}'`);
    }

    const from = parseDay(opts.from ?? shiftDay(to, -(span - 1)), "--from");
    if (from > to) {
        throw new Error(`--from ${from} is after --to ${to}`);
    }

    const maxPages = Number(opts.maxPages);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error(`--max-pages must be a positive whole number, got '${opts.maxPages}'`);
    }

    if (!FORMATS.includes(opts.format)) {
        throw new Error(`--format must be text, md or json, got '${opts.format}'`);
    }

    const api = await resolveApi({ host: opts.host });
    const user = opts.user ? await findUser(api, opts.user) : await currentUser(api);
    if (!user) {
        throw new Error(`No GitLab user with username '${opts.user}'`);
    }

    const { after, before } = apiWindow({ from, to });
    const query = new URLSearchParams({ after, before, per_page: String(PER_PAGE) });

    if (opts.action) {
        query.set("action", opts.action);
    }

    if (opts.targetType) {
        query.set("target_type", opts.targetType);
    }

    progress(
        `@${user.username} on ${api.host}: events after ${after} and before ${before} (exclusive), local days ${from}..${to} in ${tz}`
    );

    const { items, pages, truncated } = await fetchAllPages<ActivityEvent>(
        (page) => restGetPage<ActivityEvent>(api, `/users/${user.id}/events?${query}&page=${page}`),
        { maxPages, perPage: PER_PAGE }
    );

    if (truncated) {
        progress(
            `⚠ stopped at --max-pages ${maxPages} while GitLab still announced more pages: older events in the window were NOT read`
        );
    }

    const projects = new Map<number, string>();
    const projectIds = [
        ...new Set(items.map((e) => e.project_id).filter((id): id is number => typeof id === "number")),
    ];

    await pool(projectIds, 4, async (id) => {
        try {
            projects.set(id, (await getProject(api, id)).path_with_namespace);
        } catch (e) {
            progress(`  project ${id}: ${errorMessage(e)} (shown as project#${id})`);
        }
    });

    const report = buildReport({
        events: items,
        projects,
        range: { from, to },
        tz,
        user: user.username,
        fetched: items.length,
        pages,
        truncated,
        project: opts.project,
        host: api.host,
    });

    progress(`fetched ${items.length} event(s) over ${pages} page(s); ${report.inRange} in range`);

    const rendered =
        opts.format === "json"
            ? `${SafeJSON.stringify(report, null, 2)}\n`
            : opts.format === "md"
              ? renderMarkdown(report, { detail: opts.detail })
              : renderText(report, { detail: opts.detail });

    if (opts.output) {
        writeFileSync(opts.output, rendered);
        progress(`wrote ${opts.output}`);

        return;
    }

    out.print(rendered);
}
