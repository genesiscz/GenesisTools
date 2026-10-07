/**
 * `gitlab pr <iid> comments …`: list threads, write draft replies and new comments, verify anchors,
 * resolve threads, publish.
 *
 *   tools gitlab pr 42 comments --unresolved
 *   tools gitlab pr 42 comments reply 3f9c2d1 --body-file reply.md
 *   tools gitlab pr 42 comments reply 3f9c2d1 --body-file r.md --now --resolve
 *   tools gitlab pr 42 comments add --file src/api/client.ts --line 34 --body-file note.md
 *   tools gitlab pr 42 comments add --top-level --body-file note.md
 *   tools gitlab pr 42,43 comments add --top-level --now --body "Rebased."
 *   tools gitlab pr 42 comments drafts
 *   tools gitlab pr 42 comments delete 501
 *   tools gitlab pr 42 comments resolve 3f9c2d1
 *   tools gitlab pr 42 comments publish --expect 501,502 --apply
 *
 * `reply` folds into an existing draft on the same thread instead of failing, because GitLab
 * allows only one pending draft per discussion per author.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runBatchComment } from "@app/gitlab/commands/batch-comment";
import { type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { currentUser, type ProjectApi, resolveProjectApi } from "@app/gitlab/lib/client";
import {
    deleteDraft,
    fetchDiscussions,
    fetchDrafts,
    findUnanchoredDrafts,
    postReplyNow,
    publishAllDrafts,
    renderDiscussionTable,
    renderDraftTable,
    resolveAnchor,
    resolveDiscussion,
    writeDraftReply,
    writePositionedDraft,
    writeTopLevelDraft,
} from "@app/gitlab/lib/review-drafts";
import { expectedDraftIds, recordPublished } from "@app/gitlab/lib/review-items";
import { rewriteLocalImages, uploadToProject } from "@app/gitlab/lib/uploads";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface DiscussionsOptions extends TargetOptions {
    author?: string;
    mine?: boolean;
    unresolved?: boolean;
    json?: boolean;
}

interface DraftReplyOptions extends TargetOptions {
    discussion?: string;
    topLevel?: boolean;
    file?: string;
    line?: string;
    now?: boolean;
    resolve?: boolean;
    body?: string;
    bodyFile?: string;
    append?: boolean;
    dryRun?: boolean;
}

interface DraftsOptions extends TargetOptions {
    json?: boolean;
}

interface ResolveOptions extends TargetOptions {
    unresolve?: boolean;
}

interface PublishOptions extends TargetOptions {
    expect?: string;
    apply?: boolean;
}

function readBody(opts: { body?: string; bodyFile?: string }): string {
    if (opts.bodyFile) {
        return readFileSync(opts.bodyFile, "utf-8");
    }

    if (opts.body) {
        return opts.body;
    }

    throw new Error("Give --body-file <path> (preferred) or --body <text>.");
}

const MR_ARG = "MR iid (the number after `pr`)";

function withBody(cmd: Command): Command {
    return cmd
        .option("--body <text>", "Body; prefer --body-file for anything with newlines or backticks")
        .option(
            "--body-file <path>",
            "Read the body from a file; ![alt](local.png) images are uploaded to the project first"
        );
}

/** `pr comments` with its verbs; a bare `pr <iid> comments` runs `list`. */
export function registerComments(pr: Command): Command {
    const comments = pr
        .command("comments")
        .description("Threads, my drafts, replies, new comments, resolving and publishing on one MR");

    withProject(
        comments
            .command("list")
            .description("Every thread: who started it, where it is anchored, whether it is resolved")
            .argument("<iid>", MR_ARG)
            .option("--author <username>", "Only threads started by this user")
            .option("--mine", "Only threads I started")
            .option("--unresolved", "Only unresolved threads")
            .option("--json", "Emit JSON instead of a table")
    ).action(runDiscussions);

    withProject(
        comments
            .command("drafts")
            .description("My pending drafts, each anchor verified")
            .argument("<iid>", MR_ARG)
            .option("--json", "Emit JSON instead of a table")
    ).action(runDrafts);

    withProject(
        withBody(
            comments
                .command("reply")
                .description(
                    "Reply in a thread as a draft; updates my existing draft on that thread instead of failing"
                )
                .argument("<iid>", MR_ARG)
                .argument("<thread>", "Discussion id (full, or a unique prefix)")
        )
            .option("--append", "Append to my existing draft instead of replacing it")
            .option("--now", "Publish the reply at once instead of leaving it as a draft")
            .option("--resolve", "Resolve the thread after replying")
    ).action((iid: string, thread: string, opts: DraftReplyOptions) =>
        runDraftReply(iid, { ...opts, discussion: thread })
    );

    withProject(
        withBody(
            comments
                .command("add")
                .description("A new comment as a draft: on a line (--file --line) or top-level (--top-level)")
                .argument("<iid>", `${MR_ARG}; a comma list with --top-level --now comments on each MR`)
        )
            .option("--file <path>", "Anchor to this file (with --line)")
            .option("--line <n>", "Anchor to this line of the new file (with --file)")
            .option("--top-level", "A comment with no line anchor")
            .option("--now", "With a comma list of MRs: post at once on each (the dedup ledger skips repeats)")
            .option("--dry-run", "With a comma list of MRs: print what would be posted")
    ).action(runAdd);

    withProject(
        comments
            .command("delete")
            .description("Delete pending drafts of mine")
            .argument("<iid>", MR_ARG)
            .argument("<drafts...>", "Draft ids (from `comments drafts`)")
    ).action(runDelete);

    withProject(
        comments
            .command("resolve")
            .description("Resolve threads")
            .argument("<iid>", MR_ARG)
            .argument("<threads...>", "Discussion ids (full, or unique prefixes)")
            .option("--unresolve", "Reopen them instead")
    ).action(runResolve);

    withProject(
        comments
            .command("publish")
            .description("Submit every pending draft of mine as one review; a dry run until --apply")
            .argument("<iid>", MR_ARG)
            .option("--expect <ids>", "Draft ids I approved; refuses when the pending set differs")
            .option("--apply", "Publish for real")
    ).action(runPublish);

    return comments;
}

async function runDiscussions(iid: string, opts: DiscussionsOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    let discussions = await fetchDiscussions(api, iid);

    if (opts.mine) {
        const me = await currentUser(api);
        discussions = discussions.filter((d) => d.author === me.username);
    }

    if (opts.author) {
        discussions = discussions.filter((d) => d.author === opts.author);
    }

    if (opts.unresolved) {
        discussions = discussions.filter((d) => !d.resolved);
    }

    if (opts.json) {
        out.println(SafeJSON.stringify(discussions, null, 2));

        return;
    }

    if (discussions.length === 0) {
        out.println("No matching threads.");

        return;
    }

    out.println(`!${iid} — ${discussions.length} thread(s)\n`);
    out.println("id            author           state     n  anchor");
    out.println(renderDiscussionTable(discussions));
    out.println("\nSecond person in a reply addresses the thread's author shown above.");
}

async function runDraftReply(iid: string, opts: DraftReplyOptions): Promise<void> {
    const anchored = Boolean(opts.file || opts.line);

    if (anchored && !(opts.file && opts.line)) {
        throw new Error("--file and --line go together.");
    }

    // `Number("34a")` is NaN, which serializes as `null`, and GitLab accepts a null `new_line`:
    // the draft then lands unanchored as a top-level note that has to be deleted by hand.
    if (opts.line && (!/^\d+$/.test(opts.line) || Number(opts.line) < 1)) {
        throw new Error(`--line must be a positive line number, got "${opts.line}"`);
    }

    if (!opts.discussion && !opts.topLevel && !anchored) {
        throw new Error("Give --discussion <id>, or --file/--line, or --top-level.");
    }

    // These three act on a thread reply only. The anchored and top-level paths returned before
    // reaching them, so `--top-level --now` exited 0 and left a PRIVATE draft instead of the
    // public note that was asked for. Refused before any request is made.
    const threadOnly = [opts.now && "--now", opts.append && "--append", opts.resolve && "--resolve"].filter(
        (flag): flag is string => typeof flag === "string"
    );

    if (threadOnly.length > 0 && (anchored || opts.topLevel || !opts.discussion)) {
        throw new Error(
            `${threadOnly.join(", ")} can only be used with a reply. For a top-level or anchored note, write the draft and publish it with \`${toolCommand("gitlab pr", iid, "comments", "publish")}\`.`
        );
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    // The destination is checked before any image is uploaded: an upload cannot be taken back, so a
    // wrong line or thread must fail while nothing has left the machine.
    const position = anchored
        ? await resolveAnchor(api, { iid, path: opts.file ?? "", line: Number(opts.line) })
        : null;

    if (typeof position === "string") {
        throw new Error(position);
    }

    const discussionId =
        anchored || opts.topLevel || !opts.discussion ? null : await resolveDiscussionId(api, iid, opts.discussion);
    const baseDir = opts.bodyFile ? dirname(resolve(opts.bodyFile)) : process.cwd();
    const images = await rewriteLocalImages(readBody(opts), baseDir, (path) => uploadToProject(api, path));
    const body = images.body;

    for (const file of images.uploaded) {
        out.println(`📎 uploaded ${file.localPath} → ${file.url}`);
    }

    if (position) {
        const result = await writePositionedDraft(api, { iid, body, position });
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ draft ${result.draftId} anchored to ${opts.file}:${opts.line}`);

        return;
    }

    if (discussionId === null) {
        const result = await writeTopLevelDraft(api, iid, body);
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ draft ${result.draftId} created as a top-level note on !${iid}`);

        return;
    }

    if (opts.now) {
        const posted = await postReplyNow(api, { iid, discussionId, body });
        if (!posted.ok) {
            throw new Error(posted.error);
        }

        out.println(`✅ note ${posted.noteId} published in ${discussionId.slice(0, 12)}`);
        await resolveIfAsked(api, { iid, discussionId, resolve: opts.resolve });

        return;
    }

    const result = await writeDraftReply(api, { iid, discussionId, body, append: Boolean(opts.append) });
    if (!result.ok) {
        throw new Error(result.error);
    }

    const verb = result.action === "updated" ? "updated (a draft already existed on this thread)" : "created";
    out.println(`✅ draft ${result.draftId} ${verb}`);
    out.println(`   discussion_id: ${result.discussionId ?? "null — NOT a reply, check the discussion id"}`);

    if (!result.discussionId) {
        process.exitCode = 1;

        return;
    }

    await resolveIfAsked(api, { iid, discussionId, resolve: opts.resolve });
}

async function resolveIfAsked(
    api: ProjectApi,
    thread: { iid: string; discussionId: string; resolve?: boolean }
): Promise<void> {
    if (!thread.resolve) {
        return;
    }

    const resolved = await resolveDiscussion(api, { iid: thread.iid, discussionId: thread.discussionId });
    if (!resolved.ok) {
        throw new Error(`reply landed but resolve failed: ${resolved.error}`);
    }

    out.println("   thread resolved");
}

/** A GitLab discussion id is a SHA1, so a full one needs no lookup and saves a request. */
const isFullDiscussionId = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

async function resolveDiscussionId(api: ProjectApi, iid: string, provided: string): Promise<string> {
    if (isFullDiscussionId(provided)) {
        return provided;
    }

    const discussions = await fetchDiscussions(api, iid);
    const matches = discussions.filter((d) => d.id === provided || d.id.startsWith(provided));
    const only = matches[0];

    if (matches.length === 1 && only) {
        return only.id;
    }

    if (matches.length === 0) {
        throw new Error(
            `No thread on !${iid} matches "${provided}". Run: ${toolCommand("gitlab pr", iid, "comments")}`
        );
    }

    throw new Error(
        [
            `"${provided}" matches ${matches.length} threads. Use a longer prefix:`,
            ...matches.map((match) => `  ${match.id}  ${match.path ?? "TOP-LEVEL"}`),
        ].join("\n")
    );
}

async function runDrafts(iid: string, opts: DraftsOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const drafts = await fetchDrafts(api, iid);

    if (opts.json) {
        out.println(SafeJSON.stringify(drafts, null, 2));

        return;
    }

    if (drafts.length === 0) {
        out.println(`!${iid} — no pending drafts.`);

        return;
    }

    out.println(`!${iid} — ${drafts.length} pending draft(s)\n`);
    out.println("    id  target                    length  anchor");
    out.println(renderDraftTable(drafts));

    const unanchored = findUnanchoredDrafts(drafts);
    if (unanchored.length > 0) {
        out.println(`\n⚠️  ${unanchored.length} draft(s) are top-level. Intentional, or a bad discussion id:`);
        for (const draft of unanchored) {
            out.println(`    ${draft.id}: ${draft.note.slice(0, 70).replace(/\s+/g, " ")}`);
        }
    }

    out.println(
        `\nPublish with: ${toolCommand("gitlab pr", iid, "comments", "publish", "--expect", drafts.map((d) => d.id).join(","))}`
    );
}

/** A comma list of MRs posts one top-level note on each through the batch path; one MR writes a draft. */
async function runAdd(iidArg: string, opts: DraftReplyOptions): Promise<void> {
    if (!iidArg.includes(",")) {
        if (opts.now || opts.dryRun) {
            throw new Error(
                "--now and --dry-run on `comments add` are for a comma list of MRs. One MR gets a draft; publish it with `comments publish`."
            );
        }

        await runDraftReply(iidArg, opts);

        return;
    }

    if (!opts.topLevel || opts.file || opts.line) {
        throw new Error("A comma list of MRs takes only --top-level comments.");
    }

    if (!opts.now && !opts.dryRun) {
        throw new Error(
            "A comma list of MRs posts at once (no drafts): add --now, or --dry-run to see what would be posted."
        );
    }

    await runBatchComment(iidArg, {
        host: opts.host,
        project: opts.project,
        comment: readBody(opts),
        dryRun: opts.dryRun,
    });
}

async function runDelete(iid: string, ids: string[], opts: TargetOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });

    for (const id of ids) {
        if (!/^\d+$/.test(id)) {
            throw new Error(
                `A draft id is a number (see \`${toolCommand("gitlab pr", iid, "comments", "drafts")}\`), got "${id}"`
            );
        }

        const result = await deleteDraft(api, iid, Number(id));
        if (!result.ok) {
            throw new Error(`draft ${id}: ${result.error}`);
        }

        out.println(`✅ draft ${id} deleted`);
    }
}

async function runResolve(iid: string, threads: string[], opts: ResolveOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });

    for (const thread of threads) {
        const discussionId = await resolveDiscussionId(api, iid, thread);
        const result = await resolveDiscussion(api, { iid, discussionId, resolved: !opts.unresolve });
        if (!result.ok) {
            throw new Error(`${discussionId.slice(0, 12)}: ${result.error}`);
        }

        out.println(`✅ ${discussionId.slice(0, 12)} ${opts.unresolve ? "reopened" : "resolved"}`);
    }
}

/** Publishing submits EVERY pending draft of mine, so it shows the set first and needs --apply. */
async function runPublish(iid: string, opts: PublishOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const drafts = await fetchDrafts(api, iid);

    if (drafts.length > 0) {
        out.println(`!${iid} — ${drafts.length} pending draft(s) would be published:\n`);
        out.println(renderDraftTable(drafts));
    }

    // Before the empty check: an approved draft that was deleted or already published is a refusal, not a no-op.
    if (opts.expect !== undefined) {
        const { ids: expected, unknown } = expectedDraftIds(api, Number(iid), opts.expect.split(","));

        if (unknown.length > 0) {
            throw new Error(
                `--expect names ${unknown.join(", ")}, which this MR's id map does not know; nothing was published.`
            );
        }

        const pending = new Set(drafts.map((draft) => String(draft.id)));
        const unexpected = [...pending].filter((id) => !expected.has(id));
        const missing = [...expected].filter((id) => !pending.has(id));

        if (unexpected.length > 0 || missing.length > 0) {
            if (unexpected.length > 0) {
                out.println(`\n⛔ pending but not in --expect: ${unexpected.join(", ")}`);
            }

            if (missing.length > 0) {
                out.println(`⛔ in --expect but not pending: ${missing.join(", ")}`);
            }

            throw new Error("The pending drafts differ from --expect; nothing was published.");
        }
    }

    if (drafts.length === 0) {
        out.println(`!${iid} — nothing to publish.`);

        return;
    }

    if (!opts.apply) {
        out.println(
            `\nDry run. Publish with: ${toolCommand("gitlab pr", iid, "comments", "publish", "--expect", drafts.map((d) => d.id).join(","), "--apply")}`
        );

        return;
    }

    const result = await publishAllDrafts(api, iid);
    if (!result.ok) {
        out.println(
            `\n⛔ Publishing failed: ${result.error}\nA failed publish may already have posted some drafts. Check \`${toolCommand("gitlab pr", iid, "comments")}\` before any retry.`
        );
        process.exitCode = 1;

        return;
    }

    out.println(`\n✅ published ${drafts.length} draft(s) on !${iid}`);

    const record = await recordPublished(api, Number(iid), drafts);

    if (record.unmatched.length > 0) {
        out.println(`⚠  no thread found yet for ${record.unmatched.join(", ")}; \`--answers\` cannot reach them`);
    }
}
