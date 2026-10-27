/**
 * `gitlab inbox` — since you last looked: your MRs with new reviews, the MRs you review with new activity, and the
 * threads waiting for your reply.
 *
 *   tools gitlab inbox                       # everything since the last check, then moves the mark
 *   tools gitlab inbox --peek                # the same list, the mark stays
 *   tools gitlab inbox --since 2026-10-22T08:00
 *   tools gitlab inbox --role reviewer --all-projects --json
 *   tools gitlab inbox mark                  # moves the mark, lists nothing
 *
 * The next step for one MR is `gitlab pr <iid> comments`.
 */

import { progress, type TargetOptions, wholeDays, withProject } from "@app/gitlab/commands/shared";
import { currentUser, getProject, resolveApi, resolveProjectApi } from "@app/gitlab/lib/client";
import {
    advanceCheck,
    buildInboxReport,
    checkKey,
    collectInbox,
    DEFAULT_LOOKBACK_DAYS,
    FIRST_CHECK_HOURS,
    INBOX_ROLES,
    type InboxRole,
    inboxStatePath,
    readInboxState,
    renderInboxText,
    writeInboxState,
} from "@app/gitlab/lib/inbox";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import type { Command } from "commander";

interface ScopeOptions extends TargetOptions {
    allProjects?: boolean;
}

interface InboxOptions extends ScopeOptions {
    peek?: boolean;
    since?: string;
    role: string | boolean;
    json?: boolean;
    lookbackDays: string;
}

function isRole(value: string): value is InboxRole {
    return INBOX_ROLES.some((role) => role === value);
}

function parseTime(value: string, flag: string): string {
    const ms = Date.parse(value);

    if (Number.isNaN(ms)) {
        throw new Error(`${flag} must be a date or time GitLab understands, e.g. 2026-10-22T18:04, got "${value}"`);
    }

    return new Date(ms).toISOString();
}

function withScope(cmd: Command): Command {
    return withProject(cmd).option("--all-projects", "Every project instead of the one --project resolves to");
}

/** The API, the token's owner, the project id (null for every project) and the state key of this scope. */
async function resolveScope(opts: ScopeOptions) {
    const projectApi = opts.allProjects ? null : await resolveProjectApi({ host: opts.host, project: opts.project });
    const api = projectApi ?? (await resolveApi({ host: opts.host }));
    const me = await currentUser(api);
    const project = projectApi ? await getProject(projectApi, projectApi.project) : null;
    const scope = project ? `project ${project.path_with_namespace}` : "all projects";

    return { api, me, projectId: project?.id ?? null, scope, key: checkKey(api.host, me.username, scope) };
}

export function registerInbox(program: Command): Command {
    const inbox = withScope(
        program
            .command("inbox")
            .description(
                "Since you last looked: new reviews on your MRs, new activity on MRs you review, threads waiting for you"
            )
            .option("--peek", "List without moving the mark")
            .option("--since <time>", "List since this time instead of the mark (the mark stays)")
            .option("--role [role]", "author (your MRs) | reviewer (MRs you review) | all", "all")
            .option("--json", "The report as JSON on stdout")
            .option(
                "--lookback-days <N>",
                "How far back your comments count as taking part in an MR you are not a reviewer of",
                String(DEFAULT_LOOKBACK_DAYS)
            )
    ).action(runInbox);

    withScope(
        inbox
            .command("mark")
            .description("Move the mark without listing anything")
            .option("--at <time>", "Put the mark at this time instead of now")
    ).action(runMark);

    return inbox;
}

async function runInbox(opts: InboxOptions): Promise<void> {
    let role = opts.role;
    if (role === true && isInteractive()) {
        const selected = await p.select({
            message: "Inbox role",
            options: INBOX_ROLES.map((value) => ({ value, label: value })),
        });
        if (p.isCancel(selected)) {
            return;
        }
        if (typeof selected !== "string") {
            process.exitCode = 1;
            return;
        }
        role = selected;
    }
    if (typeof role !== "string" || !isRole(role)) {
        out.error(
            suggestEnumFlag(
                "tools gitlab inbox",
                "--role",
                INBOX_ROLES,
                typeof role === "string" ? { given: role } : {}
            )
        );
        process.exitCode = 1;
        return;
    }

    const lookbackDays = wholeDays(opts.lookbackDays, "--lookback-days");
    const startedAt = new Date().toISOString();
    const { api, me, projectId, scope, key } = await resolveScope(opts);
    const statePath = inboxStatePath();
    const state = readInboxState(statePath);
    const check = state.checks[key];
    const since = opts.since
        ? parseTime(opts.since, "--since")
        : (check?.lastCheckedAt ?? new Date(Date.now() - FIRST_CHECK_HOURS * 3_600_000).toISOString());
    const sinceSource = opts.since ? "flag" : check ? "mark" : "first";

    progress(
        `@${me.username} on ${api.host}, ${scope}, since ${since} (${sinceSource === "first" ? `first check: the last ${FIRST_CHECK_HOURS} h` : sinceSource})`
    );

    const result = await collectInbox(api, {
        me: { id: me.id, username: me.username },
        since,
        role,
        projectId,
        marks: opts.since ? {} : (check?.mrs ?? {}),
        lookbackDays,
        progress,
    });
    const report = buildInboxReport({
        host: api.host,
        user: me.username,
        scope,
        since,
        sinceSource,
        seen: result.seen,
        otherTodos: result.otherTodos,
        errors: result.errors,
    });

    if (opts.json) {
        out.result(report);
    } else {
        out.print(renderInboxText(report));
    }

    if (result.errors.length > 0) {
        progress(`⚠ ${result.errors.length} request(s) failed, so the list may be incomplete and the mark stays:`);
        for (const error of result.errors) {
            progress(`  ${error}`);
        }

        process.exitCode = 1;
        return;
    }

    if (opts.peek || opts.since || role !== "all") {
        progress(`the mark stays at ${check?.lastCheckedAt ?? "none (no check yet)"}`);
        return;
    }

    await withFileLock(`${statePath}.lock`, async () => {
        const latest = readInboxState(statePath);
        if (SafeJSON.stringify(latest.checks[key] ?? null) !== SafeJSON.stringify(check ?? null)) {
            progress("mark changed during this check; leaving it unchanged");
            return;
        }
        latest.checks[key] = advanceCheck(check, startedAt, result.seen);
        writeInboxState(statePath, latest);
        progress(`mark moved to ${startedAt} (${statePath})`);
    });
}

async function runMark(_opts: ScopeOptions & { at?: string }, command: Command): Promise<void> {
    const opts = command.optsWithGlobals<ScopeOptions & { at?: string }>();
    const at = opts.at ? parseTime(opts.at, "--at") : new Date().toISOString();
    const { key } = await resolveScope(opts);
    const statePath = inboxStatePath();
    await withFileLock(`${statePath}.lock`, async () => {
        const state = readInboxState(statePath);
        // Without a fetch there are no note ids to record, so the time decides for every MR.
        state.checks[key] = { lastCheckedAt: at, mrs: {} };
        writeInboxState(statePath, state);
    });
    out.println(`Mark set to ${at} for ${key} (${statePath})`);
}
