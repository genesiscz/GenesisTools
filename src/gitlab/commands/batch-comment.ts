/**
 * Batch-comment on MRs with dedup, retry, and timeout.
 *
 *   tools gitlab batch-comment 12,34,56 --comment "your message"
 *   tools gitlab batch-comment 12 --comment "test" --dry-run
 *
 * Dedup: every posted comment is appended to ~/.genesis-tools/gitlab/comment-batch.jsonl, and a
 * (project, MR, message) triple already there is skipped.
 */

import { type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import {
    appendLedger,
    isDuplicate,
    ledgerPath,
    type PostResult,
    postComment,
    readLedger,
} from "@app/gitlab/lib/comment-batch";
import { parseIids } from "@app/gitlab/lib/label-batch";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Options extends TargetOptions {
    comment: string;
    dryRun?: boolean;
}

export function registerBatchComment(parent: Command): Command {
    return withProject(
        parent
            .command("batch-comment")
            .description("Batch-comment on MRs with dedup, retry, and timeout")
            .argument("<iids>", "Comma-separated MR IIDs (e.g. 12,34,56)")
            .requiredOption("--comment <message>", "Comment body to post on each MR")
            .option("--dry-run", "Print what would be posted without calling the API")
    ).action(runBatchComment);
}

async function runBatchComment(iidsArg: string, opts: Options): Promise<void> {
    const iids = parseIids(iidsArg).map(String);
    const comment = opts.comment;
    const dryRun = Boolean(opts.dryRun);
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });

    out.println(`Project: ${api.project} on ${api.host}`);
    out.println(`MRs: ${iids.map((i) => `!${i}`).join(", ")}`);
    out.println(`Comment: ${comment.slice(0, 80)}${comment.length > 80 ? "..." : ""}`);
    out.println(`Dry run: ${dryRun}`);
    out.println(`Ledger: ${ledgerPath()}`);
    out.println("---");

    const ledger = readLedger();
    const results: PostResult[] = [];

    for (const iid of iids) {
        if (isDuplicate(ledger, { project: api.project, iid, message: comment })) {
            out.println(`⏭️  !${iid} — SKIPPED (duplicate: same message already posted)`);
            results.push({ iid, ok: true, status: 0, skipped: true });
            continue;
        }

        if (dryRun) {
            out.println(`[DRY] !${iid} — would comment`);
            results.push({ iid, ok: true, status: 0 });
            continue;
        }

        const r = await postComment(api, iid, comment);
        if (r.ok) {
            out.println(`✅ !${r.iid} — ok (${r.status}, note #${r.commentId})`);
            appendLedger({
                project: api.project,
                pr: iid,
                comment_id: r.commentId ?? 0,
                message: comment,
                ts: new Date().toISOString(),
            });
        } else {
            out.println(`❌ !${r.iid} — FAIL: ${r.error}`);
        }

        results.push(r);
    }

    const posted = results.filter((r) => r.ok && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    const fail = results.filter((r) => !r.ok);
    out.println("\n=== SUMMARY ===");
    out.println(`Posted: ${posted.length}  Skipped (dup): ${skipped.length}  Failed: ${fail.length}`);

    if (fail.length) {
        out.println("Failed IIDs (retry these):");
        out.println(fail.map((r) => r.iid).join(","));
        process.exitCode = 1;
    }
}
