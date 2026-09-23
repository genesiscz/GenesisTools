/**
 * `gitlab activity` core: one user's events grouped per LOCAL day.
 *
 * GitLab's `after`/`before` filters are exclusive and date-only, and events carry UTC timestamps,
 * so an event at 23:30 in Central Europe lands on the next UTC day. The query window is therefore widened
 * by two days on each side and the range is applied after converting `created_at` to the local day.
 */

import type { GitLabEvent } from "@app/gitlab/lib/client";

export interface ActivityNote {
    id?: number;
    body?: string;
    noteable_type?: string;
    noteable_iid?: number | null;
}

export interface ActivityEvent extends GitLabEvent {
    author_username?: string;
    target_iid?: number | null;
    target_title?: string | null;
    note?: ActivityNote;
}

export interface DayRange {
    from: string;
    to: string;
}

export interface Described {
    verb: string;
    target: string;
    title: string;
    commits: number;
}

export interface ActivityRow extends Described {
    at: string;
    day: string;
    time: string;
    project: string;
    note?: string;
    /** The event itself: a comment links to its note anchor. */
    url?: string;
    /** The MR, issue or branch the event belongs to. */
    targetLink?: string;
    projectUrl?: string;
}

export interface ActivityGroup extends Described {
    project: string;
    count: number;
    first: string;
    last: string;
    url?: string;
    projectUrl?: string;
}

export interface ActivityDay {
    day: string;
    weekday: string;
    total: number;
    commits: number;
    groups: ActivityGroup[];
    rows: ActivityRow[];
}

export interface ActivityReport {
    user: string;
    from: string;
    to: string;
    tz: string;
    fetched: number;
    pages: number;
    truncated: boolean;
    inRange: number;
    projects: string[];
    days: ActivityDay[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseDay(value: string, label: string): string {
    if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
        throw new Error(`${label} must be a date as YYYY-MM-DD, got '${value}'`);
    }

    return value;
}

/** Calendar arithmetic on a YYYY-MM-DD string; noon UTC keeps DST out of it. */
export function shiftDay(day: string, delta: number): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);

    return d.toISOString().slice(0, 10);
}

export function weekday(day: string): string {
    return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? "?";
}

/** The exclusive `after`/`before` pair that is guaranteed to contain every local day of the range. */
export function apiWindow(range: DayRange): { after: string; before: string } {
    return { after: shiftDay(range.from, -2), before: shiftDay(range.to, 2) };
}

export function localDay(iso: string, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(iso)
    );
}

export function localTime(iso: string, tz: string): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(
        new Date(iso)
    );
}

function oneLine(text: string | undefined | null, max: number): string {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function noteTarget(note: ActivityNote | undefined): string {
    const iid = note?.noteable_iid;

    switch (note?.noteable_type) {
        case "MergeRequest":
            return iid ? `!${iid}` : "merge request";
        case "Issue":
            return iid ? `#${iid}` : "issue";
        case "Commit":
            return "commit";
        default:
            return note?.noteable_type ?? "";
    }
}

/** Human wording for one event. Pushes name the ref and carry the commit count. */
export function describeEvent(event: ActivityEvent): Described {
    const push = event.push_data;

    if (push) {
        const ref = push.ref ?? "";
        const refType = push.ref_type ?? "branch";

        if (push.action === "created") {
            return {
                verb: `pushed new ${refType}`,
                target: ref,
                title: push.commit_title ?? "",
                commits: push.commit_count ?? 0,
            };
        }

        if (push.action === "removed") {
            return { verb: `deleted ${refType}`, target: ref, title: "", commits: 0 };
        }

        return { verb: "pushed to", target: ref, title: push.commit_title ?? "", commits: push.commit_count ?? 0 };
    }

    const type = event.target_type ?? "";
    const title = event.target_title ?? "";

    if (type.endsWith("Note")) {
        return { verb: "commented on", target: noteTarget(event.note), title, commits: 0 };
    }

    const verb = event.action_name === "accepted" ? "merged" : event.action_name;

    if (type === "MergeRequest") {
        return { verb, target: event.target_iid ? `!${event.target_iid}` : "merge request", title, commits: 0 };
    }

    if (type === "Issue") {
        return { verb, target: event.target_iid ? `#${event.target_iid}` : "issue", title, commits: 0 };
    }

    return { verb, target: type ? `${type}${event.target_iid ? ` ${event.target_iid}` : ""}` : "", title, commits: 0 };
}

export interface BuildArgs {
    events: ActivityEvent[];
    projects: Map<number, string>;
    range: DayRange;
    tz: string;
    user: string;
    fetched: number;
    pages: number;
    truncated: boolean;
    project?: string;
    /** Web root such as `https://gitlab.example.com`; with it, rows and groups carry links. */
    host?: string;
}

/** Web link for what an event is about; `undefined` for an unreadable project or a deleted ref. */
export function targetUrl(
    host: string,
    project: string,
    event: ActivityEvent,
    opts: { anchor: boolean }
): string | undefined {
    if (project.startsWith("project#")) {
        return undefined;
    }

    const base = `${host.replace(/\/$/, "")}/${project}`;
    const push = event.push_data;

    if (push) {
        if (push.action === "removed" || !push.ref) {
            return undefined;
        }

        return push.ref_type === "tag"
            ? `${base}/-/tags/${encodeURIComponent(push.ref)}`
            : `${base}/-/commits/${encodeURIComponent(push.ref)}`;
    }

    const type = event.target_type ?? "";

    if (type.endsWith("Note")) {
        const iid = event.note?.noteable_iid;
        const anchor = opts.anchor && event.note?.id ? `#note_${event.note.id}` : "";

        if (event.note?.noteable_type === "MergeRequest" && iid) {
            return `${base}/-/merge_requests/${iid}${anchor}`;
        }

        if (event.note?.noteable_type === "Issue" && iid) {
            return `${base}/-/issues/${iid}${anchor}`;
        }

        return undefined;
    }

    if (type === "MergeRequest" && event.target_iid) {
        return `${base}/-/merge_requests/${event.target_iid}`;
    }

    if (type === "Issue" && event.target_iid) {
        return `${base}/-/issues/${event.target_iid}`;
    }

    return undefined;
}

function projectName(projects: Map<number, string>, id: number): string {
    return projects.get(id) ?? `project#${id}`;
}

function matchesProject(filter: string | undefined, id: number, path: string): boolean {
    if (!filter) {
        return true;
    }

    return filter === String(id) || filter.toLowerCase() === path.toLowerCase();
}

/** Every weekday of the range appears, even with no events; a weekend day appears only when it has events. */
export function buildReport(args: BuildArgs): ActivityReport {
    const byDay = new Map<string, ActivityRow[]>();

    for (const event of args.events) {
        const day = localDay(event.created_at, args.tz);

        if (day < args.range.from || day > args.range.to) {
            continue;
        }

        const project = projectName(args.projects, event.project_id);

        if (!matchesProject(args.project, event.project_id, project)) {
            continue;
        }

        const row: ActivityRow = {
            ...describeEvent(event),
            at: event.created_at,
            day,
            time: localTime(event.created_at, args.tz),
            project,
        };
        const note = oneLine(event.note?.body, 120);

        if (note) {
            row.note = note;
        }

        if (args.host && !project.startsWith("project#")) {
            row.url = targetUrl(args.host, project, event, { anchor: true });
            row.targetLink = targetUrl(args.host, project, event, { anchor: false });
            row.projectUrl = `${args.host.replace(/\/$/, "")}/${project}`;
        }

        const rows = byDay.get(day) ?? [];
        rows.push(row);
        byDay.set(day, rows);
    }

    for (let day = args.range.from; day <= args.range.to; day = shiftDay(day, 1)) {
        const dow = new Date(`${day}T12:00:00Z`).getUTCDay();

        if (dow !== 0 && dow !== 6 && !byDay.has(day)) {
            byDay.set(day, []);
        }
    }

    const days = [...byDay.keys()].sort().map((day) => summarizeDay(day, byDay.get(day) ?? []));
    const projects = [...new Set(days.flatMap((d) => d.rows.map((r) => r.project)))].sort();

    return {
        user: args.user,
        from: args.range.from,
        to: args.range.to,
        tz: args.tz,
        fetched: args.fetched,
        pages: args.pages,
        truncated: args.truncated,
        inRange: days.reduce((n, d) => n + d.total, 0),
        projects,
        days,
    };
}

function summarizeDay(day: string, unsorted: ActivityRow[]): ActivityDay {
    const rows = [...unsorted].sort((a, b) => a.at.localeCompare(b.at));
    const groups = new Map<string, ActivityGroup>();

    for (const row of rows) {
        const key = `${row.verb}\u0000${row.target}\u0000${row.project}`;
        const group = groups.get(key);

        if (group) {
            group.count++;
            group.commits += row.commits;
            group.last = row.time;
            group.title = row.title || group.title;
        } else {
            groups.set(key, {
                verb: row.verb,
                target: row.target,
                title: row.title,
                commits: row.commits,
                project: row.project,
                count: 1,
                first: row.time,
                last: row.time,
                ...(row.targetLink ? { url: row.targetLink } : {}),
                ...(row.projectUrl ? { projectUrl: row.projectUrl } : {}),
            });
        }
    }

    return {
        day,
        weekday: weekday(day),
        total: rows.length,
        commits: rows.reduce((n, r) => n + r.commits, 0),
        groups: [...groups.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first)),
        rows,
    };
}

function groupLine(g: ActivityGroup, withProject: boolean): string {
    const label = [g.verb, g.target].filter(Boolean).join(" ");
    const commits = g.commits ? ` · ${g.commits} commit${g.commits === 1 ? "" : "s"}` : "";
    const title = g.title ? ` ${oneLine(g.title, 90)}` : "";
    const where = withProject ? ` [${g.project}]` : "";
    const span = g.first === g.last ? g.first : `${g.first}-${g.last}`;

    return `${String(g.count).padStart(4)}x ${label}${title}${commits}${where}  (${span})`;
}

function header(report: ActivityReport): string {
    const scope = report.projects.length === 1 ? ` · ${report.projects[0]}` : "";
    const trunc = report.truncated ? " · TRUNCATED, raise --max-pages" : "";

    return `@${report.user} · ${report.from}..${report.to} · ${report.tz}${scope} · ${report.inRange} events in range (${report.fetched} fetched over ${report.pages} page(s))${trunc}`;
}

export function renderText(report: ActivityReport, opts: { detail?: boolean } = {}): string {
    const withProject = report.projects.length > 1;
    const lines = [header(report)];

    for (const d of report.days) {
        const commits = d.commits ? ` · ${d.commits} commit${d.commits === 1 ? "" : "s"} pushed` : "";
        lines.push("", `=== ${d.day} ${d.weekday} · ${d.total} event${d.total === 1 ? "" : "s"}${commits} ===`);

        if (!d.total) {
            lines.push("     (no events)");
            continue;
        }

        for (const g of d.groups) {
            lines.push(groupLine(g, withProject));
        }

        if (opts.detail) {
            lines.push("   --");

            for (const r of d.rows) {
                const label = [r.verb, r.target].filter(Boolean).join(" ");
                const note = r.note ? `  «${r.note}»` : "";
                const where = withProject ? ` [${r.project}]` : "";
                lines.push(`   ${r.time} ${label} ${oneLine(r.title, 70)}${where}${note}`.trimEnd());
            }
        }
    }

    return `${lines.join("\n")}\n`;
}

function mdCell(text: string): string {
    return text.replace(/\|/g, "\\|");
}

export function renderMarkdown(report: ActivityReport, opts: { detail?: boolean } = {}): string {
    const withProject = report.projects.length > 1;
    const lines = [`# GitLab activity @${report.user}`, "", header(report)];

    for (const d of report.days) {
        const commits = d.commits ? `, ${d.commits} commit${d.commits === 1 ? "" : "s"} pushed` : "";
        lines.push("", `## ${d.day} ${d.weekday} (${d.total} events${commits})`, "");

        if (!d.total) {
            lines.push("No events.");
            continue;
        }

        lines.push(`| Count | Action | Title |${withProject ? " Project |" : ""} Time |`);
        lines.push(`|---|---|---|${withProject ? "---|" : ""}---|`);

        for (const g of d.groups) {
            const label = mdCell([g.verb, g.target].filter(Boolean).join(" "));
            const action = (g.url ? `[${label}](${g.url})` : label) + (g.commits ? ` (${g.commits} commits)` : "");
            const span = g.first === g.last ? g.first : `${g.first}-${g.last}`;
            const projectCell = g.projectUrl ? `[${mdCell(g.project)}](${g.projectUrl})` : mdCell(g.project);
            const project = withProject ? ` ${projectCell} |` : "";
            lines.push(`| ${g.count} | ${action} | ${mdCell(oneLine(g.title, 90))} |${project} ${span} |`);
        }

        if (opts.detail) {
            lines.push("", "<details><summary>Timeline</summary>", "");

            for (const r of d.rows) {
                const note = r.note ? ` «${mdCell(r.note)}»` : "";
                lines.push(
                    `- ${r.time} ${mdCell([r.verb, r.target].filter(Boolean).join(" "))} ${mdCell(oneLine(r.title, 70))}${note}`
                );
            }

            lines.push("", "</details>");
        }
    }

    return `${lines.join("\n")}\n`;
}
