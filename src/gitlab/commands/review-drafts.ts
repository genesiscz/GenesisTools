/**
 * Review-draft commands: list threads, write draft replies, verify anchors, publish.
 *
 *   tools gitlab discussions 42
 *   tools gitlab draft-reply 42 --discussion 3f9c2d1 --body-file reply.md
 *   tools gitlab draft-reply 42 --discussion 3f9c2d1 --body-file r.md --now --resolve
 *   tools gitlab draft-reply 42 --file src/api/client.ts --line 34 --body-file note.md
 *   tools gitlab draft-reply 42 --top-level --body-file note.md
 *   tools gitlab drafts 42
 *   tools gitlab drafts 42 --publish
 *   tools gitlab drafts 42 --delete 501
 *
 * `draft-reply` folds into an existing draft on the same thread instead of failing, because GitLab
 * allows only one pending draft per discussion per author.
 */

import { readFileSync } from "node:fs";
import { type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { type ProjectApi, resolveProjectApi } from "@app/gitlab/lib/client";
import {
    deleteDraft,
    fetchDiscussions,
    fetchDrafts,
    findUnanchoredDrafts,
    postReplyNow,
    publishAllDrafts,
    renderDiscussionTable,
    renderDraftTable,
    resolveDiscussion,
    writeAnchoredDraft,
    writeDraftReply,
    writeTopLevelDraft,
} from "@app/gitlab/lib/review-drafts";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface DiscussionsOptions extends TargetOptions {
    author?: string;
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
}

interface DraftsOptions extends TargetOptions {
    publish?: boolean;
    delete?: string;
    json?: boolean;
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

export function registerReviewDrafts(parent: Command): Command {
    withProject(
        parent
            .command("discussions")
            .description("List MR threads: who started each one, where it is anchored, whether it is resolved")
            .argument("<iid>", "MR IID (e.g. 42)")
            .option("--author <username>", "Only threads started by this user")
            .option("--unresolved", "Only unresolved threads")
            .option("--json", "Emit JSON instead of a table")
    ).action(runDiscussions);

    withProject(
        parent
            .command("draft-reply")
            .description(
                "Write an unpublished draft reply; updates the existing draft on that thread instead of failing"
            )
            .argument("<iid>", "MR IID (e.g. 42)")
            .option("--discussion <id>", "Discussion id to reply in (full or unique prefix)")
            .option("--top-level", "Post a standalone draft with no thread")
            .option("--file <path>", "Anchor a new draft to this file (with --line)")
            .option("--line <n>", "Anchor a new draft to this line of the new file (with --file)")
            .option("--body <text>", "Reply body; prefer --body-file for anything with newlines or backticks")
            .option("--body-file <path>", "Read the reply body from a file")
            .option("--append", "Append to the existing draft instead of replacing it")
            .option("--now", "Publish the reply immediately instead of leaving it as a draft")
            .option("--resolve", "Resolve the thread after replying (needs --discussion)")
    ).action(runDraftReply);

    return withProject(
        parent
            .command("drafts")
            .description("List pending drafts and verify each landed where it was meant to")
            .argument("<iid>", "MR IID (e.g. 42)")
            .option("--publish", "Publish every pending draft (submits the review)")
            .option("--delete <draftId>", "Delete one pending draft")
            .option("--json", "Emit JSON instead of a table")
    ).action(runDrafts);
}

async function runDiscussions(iid: string, opts: DiscussionsOptions): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    let discussions = await fetchDiscussions(api, iid);

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
            `${threadOnly.join(", ")} can only be used with --discussion. For a top-level or anchored note, write the draft and publish it with \`drafts <iid> --publish\`.`
        );
    }

    const body = readBody(opts);
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });

    if (opts.file && opts.line) {
        const result = await writeAnchoredDraft(api, { iid, path: opts.file, line: Number(opts.line), body });
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ draft ${result.draftId} anchored to ${opts.file}:${opts.line}`);

        return;
    }

    if (opts.topLevel || !opts.discussion) {
        const result = await writeTopLevelDraft(api, iid, body);
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ draft ${result.draftId} created as a top-level note on !${iid}`);

        return;
    }

    const discussionId = await resolveDiscussionId(api, iid, opts.discussion);

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
        throw new Error(`No thread on !${iid} matches "${provided}". Run: tools gitlab discussions ${iid}`);
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

    if (opts.delete) {
        const result = await deleteDraft(api, iid, Number(opts.delete));
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ draft ${opts.delete} deleted`);

        return;
    }

    const drafts = await fetchDrafts(api, iid);

    if (opts.publish) {
        if (drafts.length === 0) {
            out.println("Nothing to publish.");

            return;
        }

        const result = await publishAllDrafts(api, iid);
        if (!result.ok) {
            throw new Error(result.error);
        }

        out.println(`✅ published ${drafts.length} draft(s) on !${iid}`);

        return;
    }

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

    out.println(`\nPublish with: tools gitlab drafts ${iid} --publish`);
}
