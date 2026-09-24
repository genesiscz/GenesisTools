/**
 * Open-MR staleness report in two steps.
 *
 *   tools gitlab stale-branches preflight --out <sweep.json> [--cwd <checkout>] [--project group/name] [--review-min-age 90]
 *   ...an agent fills the `review` fields of every MR with needsReview=true...
 *   tools gitlab stale-branches merge <sweep.json> --review <slice.json>... [--out <merged.json>]
 *   tools gitlab stale-branches render <sweep.json> --out <note.md> [--ado 1234] [--allow-unfilled]
 *   tools gitlab stale-branches recheck <sweep.json> [--recommendation CLOSE] [--iid 42]   # re-run the content check, compare MR + work item with the snapshot
 *   tools gitlab stale-branches post <sweep.json> --iid 42 [--dry-run] [--force]         # ONE MR, after that draft was approved; refuses when the MR or work item moved
 *   tools gitlab stale-branches apply-labels <sweep.json> [--iid 42] [--dry-run]         # review.labels of every pending MR, after the dry-run table was approved
 *   tools gitlab stale-branches manifest <sweep.json> [--out <manifest.json>] [--status silent]   # every MR we wrote to, refetched live
 *   tools gitlab stale-branches followup <sweep.json> [--after-days 7]                   # phase 2 list: notified MRs, activity since, close candidates
 *   tools gitlab stale-branches close <sweep.json> --iid 42 [--dry-run] [--force]         # phase 2: close ONE notified MR after it was approved
 *   tools gitlab stale-branches closed-bug <sweep.json> [--select new|posted|all] [--draft] [--dry-run]   # closed bug, open MR
 *
 * The sweep JSON records the host and project it read, so every later subcommand writes to the
 * same place without --host or --project.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collect, progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { currentUser, getProject, type ProjectApi, resolveProjectApi } from "@app/gitlab/lib/client";
import {
    CLOSED_BUG_KEY,
    CLOSED_BUG_TYPES,
    closedBugFacts,
    closedBugOf,
    closedBugSummary,
    releaseTarget,
} from "@app/gitlab/lib/closed-bug";
import {
    appendLedger,
    fetchDraftNotes,
    getNote,
    ledgerFor,
    postComment,
    postDraftNote,
    publishDraftNote,
    readLedger,
    updateDraftNote,
    updateNote,
} from "@app/gitlab/lib/comment-batch";
import { type GitLabToolConfig, loadConfig } from "@app/gitlab/lib/config";
import { gitRepoRoot, gitResult } from "@app/gitlab/lib/git";
import { errorMessage } from "@app/gitlab/lib/http";
import {
    appendLabelLedger,
    expectedLabels,
    fetchMrLabels,
    type LabelChange,
    projectLabelNames,
    putMrLabels,
    readLabelLedger,
    renderChangeTable,
    sameLabels,
} from "@app/gitlab/lib/label-batch";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import { pool } from "@app/gitlab/lib/pool";
import { collectShipped, environmentRefs, labelConflicts, type ShippedRoles } from "@app/gitlab/lib/shipped";
import {
    closedBugContextOf,
    collectStaleReport,
    findReviewedMr,
    freshness,
    markLabelsApplied,
    markPosted,
    mergeReviews,
    pendingLabels,
    RECOMMENDATIONS,
    type Recommendation,
    type ReviewSource,
    renderStaleReport,
    type StaleMr,
    type StaleReport,
    unfilledReviews,
} from "@app/gitlab/lib/stale-branches";
import {
    buildManifest,
    contactedMrs,
    diffManifest,
    MANIFEST_STATUSES,
    type ManifestStatus,
    manifestEntry,
    manifestSummary,
    renderManifestTable,
    type StaleManifest,
} from "@app/gitlab/lib/stale-manifest";
import {
    branchDeleteOps,
    branchProtected,
    branchUsers,
    closeMr,
    deleteUnusedBranch,
    findPublishedDraft,
    followupRow,
    liveBranchUsers,
    markBranchDeleted,
    markClosed,
    notifiedMrs,
    renderFollowupTable,
} from "@app/gitlab/lib/stale-phases";
import { type AdoWorkItem, extractWorkItemIds, resolveAdo } from "@app/gitlab/lib/work-items";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface PreflightOptions extends TargetOptions {
    out: string;
    cwd?: string;
    reviewMinAge: string;
    inactiveAfter: string;
}

interface RenderOptions {
    out?: string;
    ado: string[];
    title?: string;
    allowUnfilled?: boolean;
    force?: boolean;
}

function localTimestamp(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function parseIid(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!/^\d+$/.test(value)) {
        throw new Error(`--iid takes exactly one MR iid, got "${value}"`);
    }

    return Number(value);
}

function requireIid(value: string): number {
    const iid = parseIid(value);
    if (iid === undefined) {
        throw new Error("--iid is required");
    }

    return iid;
}

async function loadReport(json: string): Promise<StaleReport> {
    return (await Bun.file(json).json()) as StaleReport;
}

function saveReport(json: string, report: StaleReport): void {
    writeFileSync(json, `${SafeJSON.stringify(report, null, 2)}\n`);
}

/** The host and project the sweep recorded; a JSON without them falls back to the usual resolution. */
function reportApi(report: StaleReport): Promise<ProjectApi> {
    return resolveProjectApi({ host: report.host, project: report.project, cwd: report.repoRoot });
}

async function liveAdoOf(mr: StaleMr, options: { cwd: string; config: GitLabToolConfig }): Promise<AdoWorkItem | null> {
    if (!mr.ado) {
        return null;
    }

    const resolved = await resolveAdo(mr.ado.id, { config: options.config.workItems, cwd: options.cwd });

    return "error" in resolved ? null : resolved.effective;
}

/** Usernames whose notes are not a reaction: the token owner (who wrote the notification) plus any passed. */
async function ignoredAuthors(api: ProjectApi, extra: string[]): Promise<string[]> {
    const me = await currentUser(api);

    return [...new Set([me.username, ...extra])];
}

/** Side texts not yet on GitLab in any form; they ride along in the next post of the review comment. */
function pendingSideComments(mr: StaleMr) {
    return (mr.sideComments ?? []).filter((c) => !c.postedNoteUrl && !c.draftNoteId);
}

/** The review draft plus every pending side text, one blank line apart: one comment, never two. */
function fullCommentBody(mr: StaleMr): string {
    return [(mr.review.draftComment ?? "").trimEnd(), ...pendingSideComments(mr).map((c) => c.body)].join("\n\n");
}

type DeliveryMode = "append" | "append-draft" | "draft" | "create" | "skipped";

interface Delivery {
    mode: DeliveryMode;
    ok: boolean;
    /** The result cell for the table. */
    result: string;
}

/**
 * One keyed text into the MR's single comment of ours: appended to the published sweep note,
 * else to the pending review draft, else a new note (a draft note with `draft`). Records the
 * text under `key` in `sideComments`, so a rerun never sends it twice.
 */
async function deliverSideText(
    api: ProjectApi,
    delivery: { mr: StaleMr; key: string; text: string; draft?: boolean; dryRun?: boolean }
): Promise<Delivery> {
    const { mr, key, text } = delivery;
    const iid = String(mr.iid);
    const live = await fetchMr(api, mr.iid);
    if (live.state !== "opened") {
        return { mode: "skipped", ok: true, result: `skipped, MR is ${live.state}` };
    }

    const noteId = Number(mr.review.postedNoteUrl?.match(/#note_(\d+)$/)?.[1] ?? 0);
    const existing = noteId ? await getNote(api, iid, noteId) : null;
    const pendingReviewDraft =
        !existing && mr.review.draftNoteId && !mr.review.postedNoteUrl
            ? ((await fetchDraftNotes(api, iid)).find((d) => d.id === mr.review.draftNoteId) ?? null)
            : null;
    const mode: DeliveryMode = existing
        ? "append"
        : pendingReviewDraft
          ? "append-draft"
          : delivery.draft
            ? "draft"
            : "create";
    if (delivery.dryRun) {
        return {
            mode,
            ok: true,
            result: `dry run, would ${mode}${existing ? ` to note ${noteId}` : pendingReviewDraft ? ` to draft ${pendingReviewDraft.id}` : ""}`,
        };
    }

    const result = existing
        ? await updateNote(api, { iid, noteId, body: `${existing.body.trimEnd()}\n\n${text}` })
        : pendingReviewDraft
          ? await updateDraftNote(api, {
                iid,
                draftId: pendingReviewDraft.id,
                body: `${pendingReviewDraft.note.trimEnd()}\n\n${text}`,
            })
          : delivery.draft
            ? await postDraftNote(api, iid, text)
            : await postComment(api, iid, text);
    if (!result.ok) {
        return { mode, ok: false, result: `FAIL ${result.status} ${result.error ?? ""}` };
    }

    const now = new Date().toISOString();
    if (pendingReviewDraft) {
        mr.sideComments = [...(mr.sideComments ?? []), { key, body: text, draftNoteId: pendingReviewDraft.id }];

        return { mode, ok: true, result: `appended to pending draft ${pendingReviewDraft.id}` };
    }

    if (mode === "draft") {
        mr.sideComments = [...(mr.sideComments ?? []), { key, body: text, draftNoteId: result.commentId }];

        return { mode, ok: true, result: `draft note ${result.commentId} (private until published)` };
    }

    const url = `${mr.webUrl}#note_${result.commentId ?? noteId}`;
    mr.sideComments = [...(mr.sideComments ?? []), { key, body: text, postedNoteUrl: url, postedAt: now }];
    if (!existing) {
        appendLedger({ project: api.project, pr: iid, comment_id: result.commentId ?? 0, message: text, ts: now });
    }

    return { mode, ok: true, result: `${mode === "append" ? "appended" : "created"}: ${url}` };
}

/** Refs for the content check: the sweep's own list, or recomputed from the config for a JSON written without it. */
async function shippedRefsOf(
    report: StaleReport,
    options: { cwd: string; api: ProjectApi; config: GitLabToolConfig }
): Promise<{ refs: string[]; roles: ShippedRoles }> {
    if (report.shippedRefs?.length && report.shippedRoles) {
        return { refs: report.shippedRefs, roles: report.shippedRoles };
    }

    const defaultBranch = report.defaultBranch ?? (await getProject(options.api, options.api.project)).default_branch;
    const computed = environmentRefs({
        cwd: options.cwd,
        environments: options.config.stale.environments,
        defaultBranch,
        asOf: new Date().toISOString().slice(0, 10),
    });
    report.shippedRoles = computed.roles;

    return { refs: computed.refs, roles: computed.roles };
}

function checkoutOf(report: StaleReport, flag: string | undefined): string {
    return gitRepoRoot(flag ? resolve(flag) : report.repoRoot);
}

export function registerStaleBranches(parent: Command): Command {
    const cmd = parent
        .command("stale-branches")
        .description("Open-MR staleness report: preflight JSON, agent review, render note, then two-phase cleanup");

    withProject(
        cmd
            .command("preflight")
            .description(
                "Collect every open MR with git distance, notes, author activity and its work item into a JSON with empty review fields"
            )
            .requiredOption("--out <file>", "JSON output path")
            .option("--cwd <dir>", "Local checkout of the project (default: the git root of the current directory)")
            .option("--review-min-age <days>", "MRs older than this get needsReview=true", "90")
            .option("--inactive-after <days>", "Author counts as inactive without a GitLab event for this long", "30")
    ).action(async (opts: PreflightOptions) => {
        const cwd = gitRepoRoot(opts.cwd ? resolve(opts.cwd) : process.cwd());
        const config = await loadConfig();
        const api = await resolveProjectApi({ host: opts.host, project: opts.project, cwd });
        const report = await collectStaleReport({
            api,
            config,
            cwd,
            reviewMinAgeDays: Number(opts.reviewMinAge),
            inactiveAfterDays: Number(opts.inactiveAfter),
            log: progress,
        });
        saveReport(opts.out, report);
        progress(
            `${report.mrs.length} MRs written to ${opts.out}; ${unfilledReviews(report).length} need a review pass; ${report.failures.length} failures recorded.`
        );
    });

    cmd.command("merge <json>")
        .description(
            "Copy review fields into the preflight JSON by iid from slice files ({iid: review}) or a previous sweep"
        )
        .requiredOption("--review <file>", "Review source (repeatable)", collect, [])
        .option("--out <file>", "Output path (default: overwrite <json> in place)")
        .action(async (json: string, opts: { review: string[]; out?: string }) => {
            const report = await loadReport(json);
            const sources: ReviewSource[] = [];
            for (const file of opts.review) {
                sources.push((await Bun.file(file).json()) as ReviewSource);
            }

            const { filled, missing } = mergeReviews(report, sources);
            const target = opts.out ?? json;
            saveReport(target, report);
            progress(
                `${filled} reviews merged into ${target}${missing.length ? `; still unfilled: ${missing.map((i) => `!${i}`).join(", ")}` : ""}.`
            );
        });

    cmd.command("reconcile <json>")
        .description(
            "Restore postedNoteUrl, labels, closedAt and draftNoteId of every reviewed MR from the ledgers and live GitLab, for a JSON whose operational fields were lost. Read-only on GitLab."
        )
        .action(async (json: string) => {
            const report = await loadReport(json);
            const api = await reportApi(report);
            const comments = readLedger();
            const labelLedger = readLabelLedger().filter((e) => e.project === api.project);
            const rows: string[] = [];

            await pool(
                report.mrs.filter((mr) => mr.needsReview && mr.review.draftComment),
                4,
                async (mr) => {
                    const restored: string[] = [];
                    const body = (mr.review.draftComment ?? "").trim();
                    const live = await fetchMr(api, mr.iid);

                    if (!mr.review.postedNoteUrl) {
                        const fromLedger = ledgerFor(comments, api.project, mr.iid)
                            .filter((e) => e.message.trim() === body)
                            .sort((a, b) => b.ts.localeCompare(a.ts))[0];
                        const fromLive = live.notes
                            .filter((n) => !n.system && n.body.trim() === body)
                            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

                        if (fromLive) {
                            markPosted(mr, fromLive.id, new Date(fromLive.createdAt));
                            restored.push("posted (live)");
                        } else if (fromLedger?.comment_id) {
                            markPosted(mr, fromLedger.comment_id, new Date(fromLedger.ts));
                            restored.push("posted (ledger)");
                        }
                    }

                    if (!mr.review.postedNoteUrl && !mr.review.draftNoteId) {
                        const draft = (await fetchDraftNotes(api, String(mr.iid))).find((d) => d.note.trim() === body);
                        if (draft) {
                            mr.review.draftNoteId = draft.id;
                            mr.review.draftedAt = new Date().toISOString();
                            restored.push(`draft ${draft.id}`);
                        }
                    }

                    if (!mr.review.labelsAppliedAt && mr.review.labels.length) {
                        const entry = labelLedger
                            .filter((e) => e.iid === mr.iid && e.ok && !e.dryRun)
                            .sort((a, b) => b.ts.localeCompare(a.ts))[0];
                        const liveLabels = [...live.labels].sort();
                        const expected = expectedLabels(
                            liveLabels,
                            mr.review.labels.filter((l) => l.type === "add").map((l) => l.label),
                            mr.review.labels.filter((l) => l.type === "remove").map((l) => l.label)
                        );

                        if (entry?.after) {
                            markLabelsApplied(mr, {
                                before: entry.before,
                                after: entry.after,
                                now: new Date(entry.ts),
                            });
                            restored.push("labels (ledger)");
                        } else if (sameLabels(liveLabels, expected)) {
                            markLabelsApplied(mr, { before: liveLabels, after: liveLabels });
                            restored.push("labels (live, unchanged)");
                        }
                    }

                    if (!mr.review.closedAt && live.state === "closed" && mr.review.postedNoteUrl) {
                        markClosed(mr, new Date(live.updatedAt));
                        restored.push(`closed (${live.updatedAt.slice(0, 10)})`);
                    }

                    if (restored.length) {
                        rows.push(`| !${mr.iid} | ${restored.join(", ")} |`);
                    }
                }
            );
            saveReport(json, report);
            rows.sort();
            out.println(`| MR | Restored |\n|---|---|\n${rows.join("\n")}`);
            progress(`${rows.length} MR(s) had operational state restored; written to ${json}.`);
        });

    cmd.command("sync-note <json>")
        .description(
            "Bring published sweep comments up to date with the review text in the JSON: the note body becomes the current draftComment plus whatever was appended after the original post (side texts stay). Uses the comment ledger to know the original text."
        )
        .option("--iid <n>", "Only this MR")
        .option("--dry-run", "Show which notes would change, with the changed lines")
        .action(async (json: string, opts: { iid?: string; dryRun?: boolean }) => {
            const only = parseIid(opts.iid);
            const report = await loadReport(json);
            const ledger = readLedger();
            const api = await reportApi(report);
            const targets = report.mrs.filter(
                (mr) =>
                    mr.needsReview &&
                    mr.review.draftComment &&
                    (mr.review.postedNoteUrl || mr.review.draftNoteId) &&
                    (only === undefined || mr.iid === only)
            );
            const rows: string[] = [];
            let changed = 0;

            for (const mr of targets) {
                const draftComment = (mr.review.draftComment ?? "").trim();
                const isDraft = !mr.review.postedNoteUrl;
                const noteId = isDraft
                    ? (mr.review.draftNoteId ?? 0)
                    : Number(mr.review.postedNoteUrl?.match(/#note_(\d+)$/)?.[1] ?? 0);
                const live = isDraft
                    ? await fetchDraftNotes(api, String(mr.iid)).then((list) => {
                          const d = list.find((x) => x.id === noteId);

                          return d ? { id: d.id, body: d.note, author: "" } : null;
                      })
                    : noteId
                      ? await getNote(api, String(mr.iid), noteId)
                      : null;
                if (!live) {
                    rows.push(`| !${mr.iid} | ${isDraft ? "draft" : "note"} ${noteId} not found |`);
                    continue;
                }

                const liveBody = live.body.trim();
                const original = isDraft
                    ? mr.review.sentBody?.trim()
                    : [
                          draftComment,
                          ...ledgerFor(ledger, api.project, mr.iid)
                              .filter((e) => e.comment_id === noteId)
                              .map((e) => e.message.trim()),
                      ]
                          .filter((m) => liveBody.startsWith(m))
                          .sort((a, b) => a.length - b.length)[0];
                if (!original || !liveBody.startsWith(original)) {
                    rows.push(
                        `| !${mr.iid} | live ${isDraft ? "draft" : "note"} does not start with any text this flow sent; skipped |`
                    );
                    continue;
                }

                const wanted = `${draftComment}${liveBody.slice(original.length)}`;
                if (wanted === liveBody) {
                    continue;
                }

                const oldLines = liveBody.split("\n");
                const newLines = wanted.split("\n");
                const diff = [
                    ...oldLines.filter((l) => !newLines.includes(l)).map((l) => `- ${l.slice(0, 110)}`),
                    ...newLines.filter((l) => !oldLines.includes(l)).map((l) => `+ ${l.slice(0, 110)}`),
                ];
                if (opts.dryRun) {
                    rows.push(`| !${mr.iid} | would update note ${noteId}: ${diff.join(" ⏎ ")} |`);
                    continue;
                }

                const result = isDraft
                    ? await updateDraftNote(api, { iid: String(mr.iid), draftId: noteId, body: wanted })
                    : await updateNote(api, { iid: String(mr.iid), noteId, body: wanted });
                if (!result.ok) {
                    rows.push(`| !${mr.iid} | FAIL ${result.status} ${result.error ?? ""} |`);
                    continue;
                }

                if (isDraft) {
                    mr.review.sentBody = draftComment;
                } else {
                    appendLedger({
                        project: api.project,
                        pr: String(mr.iid),
                        comment_id: noteId,
                        message: draftComment,
                        ts: new Date().toISOString(),
                    });
                }

                changed++;
                rows.push(`| !${mr.iid} | updated ${isDraft ? "draft" : "note"} ${noteId}: ${diff.join(" ⏎ ")} |`);
            }

            if (!opts.dryRun && changed) {
                saveReport(json, report);
            }

            out.println(`| MR | Result |\n|---|---|\n${rows.join("\n")}`);
            progress(
                `${targets.length} notes and drafts checked, ${opts.dryRun ? rows.filter((r) => r.includes("would update")).length : changed} ${opts.dryRun ? "would change (dry run)" : "updated"}.`
            );
        });

    cmd.command("shipped-detail <json>")
        .description(
            "Exhaustive content check of ONE MR: every significant added line of every file against the environment refs, with the lines that are NOT on the release target (UAT, else production). Writes the result into the JSON as `shipped` (exhaustive)."
        )
        .requiredOption("--iid <n>", "The MR iid")
        .option("--cwd <dir>", "Local checkout (default: repoRoot recorded in the JSON)")
        .option("--show <n>", "How many missing lines to print", "40")
        .action(async (json: string, opts: { iid: string; cwd?: string; show: string }) => {
            const iid = requireIid(opts.iid);
            const report = await loadReport(json);
            const mr = report.mrs.find((m) => m.iid === iid);
            if (!mr) {
                throw new Error(`!${iid} is not in this report`);
            }

            const config = await loadConfig();
            const cwd = checkoutOf(report, opts.cwd);
            const { refs, roles } = await shippedRefsOf(report, { cwd, api: await reportApi(report), config });
            const facts = collectShipped({
                cwd,
                sourceRef: `origin/${mr.sourceBranch}`,
                targetRef: `origin/${mr.targetBranch}`,
                checkRefs: refs,
                exhaustive: true,
            });
            mr.shipped = facts;
            mr.labelConflicts = labelConflicts(mr.labels, facts, config.stale.mergeLabelPattern);
            saveReport(json, report);
            const target = releaseTarget(roles);
            const next = facts.refs.find((r) => r.ref === target) ?? facts.refs[0];
            out.println(
                `!${mr.iid} ${mr.title}\n${facts.filesChanged} files changed, +${facts.insertions} -${facts.deletions}; ${facts.filesChecked} files with significant added lines, ${next?.sampled ?? 0} significant lines checked.\n\n| Ref | Found | Verdict |\n|---|---|---|\n${facts.refs.map((r) => `| ${r.ref} | ${r.matched}/${r.sampled} (${r.sampled ? Math.round((100 * r.matched) / r.sampled) : 0} %) | ${r.verdict} |`).join("\n")}`
            );
            if (next) {
                const missing = facts.files.flatMap((f) =>
                    f.lines.filter((l) => !l.in.includes(next.ref)).map((l) => `${f.path}: ${l.text}`)
                );
                const perFile = facts.files
                    .map((f) => ({
                        path: f.path,
                        missing: f.lines.filter((l) => !l.in.includes(next.ref)).length,
                        total: f.lines.length,
                    }))
                    .filter((f) => f.missing > 0)
                    .sort((a, b) => b.missing - a.missing);
                const show = Number(opts.show);
                out.println(
                    `\nFiles with lines missing on ${next.ref}: ${perFile.length} of ${facts.filesChecked}\n${perFile
                        .slice(0, 30)
                        .map((f) => `- ${f.path}: ${f.missing}/${f.total} missing`)
                        .join("\n")}`
                );
                out.println(
                    `\nMissing lines (${missing.length}, first ${Math.min(show, missing.length)}):\n${missing
                        .slice(0, show)
                        .map((l) => `  ${l.slice(0, 140)}`)
                        .join("\n")}`
                );
            }
        });

    cmd.command("side-comment <json>")
        .description(
            "One templated side note per selected MR ({author}, {iid}, {title}). When the sweep comment already exists on the MR, the text is appended to it in place; otherwise a new note is created. Keyed, so a rerun never posts twice."
        )
        .requiredOption("--key <slug>", "Identifier of this side sweep, recorded per MR")
        .requiredOption("--template <text>", "Comment text; {author} becomes @username, {iid} and {title} the MR")
        .option(
            "--missing-work-item",
            "Select MRs without a work-item id (workItems.idPattern) in the title or the description"
        )
        .option("--iid <n>", "Select this MR (repeatable)", collect, [])
        .option("--skip-author <username>", "Never select MRs of this author (repeatable)", collect, [])
        .option(
            "--draft",
            "A new note becomes a GitLab draft note (private until published); an append to an existing note stays a direct edit"
        )
        .option("--dry-run", "Print the plan without touching GitLab")
        .action(
            async (
                json: string,
                opts: {
                    key: string;
                    template: string;
                    missingWorkItem?: boolean;
                    iid: string[];
                    skipAuthor: string[];
                    draft?: boolean;
                    dryRun?: boolean;
                }
            ) => {
                const report = await loadReport(json);
                const config = await loadConfig();
                if (opts.missingWorkItem && !config.workItems.idPattern) {
                    throw new Error(
                        "--missing-work-item needs workItems.idPattern in ~/.genesis-tools/gitlab/config.json"
                    );
                }

                const wanted = new Set(opts.iid.map(requireIid));
                const targets = report.mrs.filter((mr) => {
                    if (mr.review.closedAt || opts.skipAuthor.includes(mr.author.username)) {
                        return false;
                    }

                    if (mr.sideComments?.some((c) => c.key === opts.key)) {
                        return false;
                    }

                    const noId = extractWorkItemIds(config.workItems.idPattern, mr.title, mr.description).length === 0;

                    return wanted.has(mr.iid) || (Boolean(opts.missingWorkItem) && noId);
                });
                if (!targets.length) {
                    progress("No MR matches (or every match already carries this key).");

                    return;
                }

                const api = await reportApi(report);
                const rows: string[] = [];
                for (const mr of targets) {
                    const text = opts.template
                        .replaceAll("{author}", `@${mr.author.username}`)
                        .replaceAll("{iid}", `!${mr.iid}`)
                        .replaceAll("{title}", mr.title);
                    const delivered = await deliverSideText(api, {
                        mr,
                        key: opts.key,
                        text,
                        draft: opts.draft,
                        dryRun: opts.dryRun,
                    });
                    rows.push(`| !${mr.iid} | ${mr.author.username} | ${delivered.result} |`);
                }

                if (!opts.dryRun) {
                    saveReport(json, report);
                }

                out.println(`| MR | Author | Result |\n|---|---|---|\n${rows.join("\n")}`);
                const failed = rows.filter((r) => r.includes("| FAIL")).length;
                progress(`${rows.length} selected, ${failed} failed${opts.dryRun ? " (dry run, nothing sent)" : ""}.`);
                if (failed) {
                    process.exitCode = 1;
                }
            }
        );

    cmd.command("closed-bug <json>")
        .description(
            "Closed bug, open MR: every open MR whose work item (Bug by default; the parent when the MR names a Task) is still Closed on a live read gets the exhaustive content check and one comment of this type saying where the fix is (released, part, test only, nowhere, unknown): appended to our sweep comment when it exists, else a new note (a draft note with --draft). Keyed `closedBug`, so a rerun never posts twice."
        )
        .option("--iid <n>", "Only this MR (repeatable)", collect, [])
        .option("--type <name>", "Work item type to consider (repeatable, default Bug)", collect, [])
        .option("--select <which>", "new: only MRs without our published comment; posted: only MRs with it; all", "all")
        .option("--skip-author <username>", "Never select MRs of this author (repeatable)", collect, [])
        .option("--cwd <dir>", "Local checkout (default: repoRoot recorded in the JSON)")
        .option(
            "--draft",
            "A new note becomes a GitLab draft note (private until published); an append to an existing note stays a direct edit"
        )
        .option("--dry-run", "Run the checks, print the texts and write the facts into the JSON; send nothing")
        .option("--show", "Print every comment text (always on with --dry-run)")
        .action(
            async (
                json: string,
                opts: {
                    iid: string[];
                    type: string[];
                    select: string;
                    skipAuthor: string[];
                    cwd?: string;
                    draft?: boolean;
                    dryRun?: boolean;
                    show?: boolean;
                }
            ) => {
                if (!["new", "posted", "all"].includes(opts.select)) {
                    throw new Error(`--select takes new, posted or all, got "${opts.select}"`);
                }

                const report = await loadReport(json);
                const config = await loadConfig();
                const types = opts.type.length ? opts.type : CLOSED_BUG_TYPES;
                const wanted = new Set(opts.iid.map(requireIid));
                const cwd = checkoutOf(report, opts.cwd);
                const api = await reportApi(report);
                const { refs } = await shippedRefsOf(report, { cwd, api, config });
                const context = closedBugContextOf(report, config, types);
                const candidates = report.mrs.filter((mr) => {
                    if (mr.review.closedAt || opts.skipAuthor.includes(mr.author.username)) {
                        return false;
                    }

                    if (wanted.size) {
                        return wanted.has(mr.iid);
                    }

                    const posted = Boolean(mr.review.postedNoteUrl);
                    if ((opts.select === "new" && posted) || (opts.select === "posted" && !posted)) {
                        return false;
                    }

                    return closedBugOf(mr, context) !== null;
                });
                if (!candidates.length) {
                    progress("No open MR with a Closed work item of the selected type(s).");

                    return;
                }

                const rows: string[] = [];
                const texts: string[] = [];
                let failed = 0;
                let sent = 0;

                for (const mr of candidates) {
                    const who = mr.author.username;
                    const liveAdo = mr.ado ? await resolveAdo(mr.ado.id, { config: config.workItems, cwd }) : null;
                    if (!liveAdo) {
                        rows.push(`| !${mr.iid} | ${who} | no work-item id | skipped |`);
                        continue;
                    }

                    if ("error" in liveAdo) {
                        rows.push(
                            `| !${mr.iid} | ${who} | ADO ${liveAdo.id} unreadable: ${liveAdo.error.slice(0, 80)} | skipped |`
                        );
                        failed++;
                        continue;
                    }

                    const item = liveAdo.effective;
                    if (item.state !== "Closed" || !types.includes(item.type)) {
                        mr.closedBug = null;
                        rows.push(
                            `| !${mr.iid} | ${who} | ADO ${item.type} ${item.id} is ${item.state} now | skipped, closedBug cleared |`
                        );
                        continue;
                    }

                    if (mr.git.sourceMissing || mr.git.targetMissing) {
                        rows.push(`| !${mr.iid} | ${who} | branch missing on origin | skipped |`);
                        continue;
                    }

                    const shipped = collectShipped({
                        cwd,
                        sourceRef: `origin/${mr.sourceBranch}`,
                        targetRef: `origin/${mr.targetBranch}`,
                        checkRefs: refs,
                        exhaustive: true,
                    });
                    mr.shipped = shipped;
                    mr.labelConflicts = labelConflicts(mr.labels, shipped, config.stale.mergeLabelPattern);
                    const facts = closedBugFacts({ item, shipped, iid: mr.iid, context });
                    mr.closedBug = facts;
                    const summary = closedBugSummary(facts);
                    if (mr.sideComments?.some((c) => c.key === CLOSED_BUG_KEY)) {
                        rows.push(`| !${mr.iid} | ${who} | ${summary} | already carries the closedBug text |`);
                        continue;
                    }

                    const delivered = await deliverSideText(api, {
                        mr,
                        key: CLOSED_BUG_KEY,
                        text: facts.comment,
                        draft: opts.draft,
                        dryRun: opts.dryRun,
                    });
                    if (!delivered.ok) {
                        failed++;
                    } else if (!opts.dryRun && delivered.mode !== "skipped") {
                        sent++;
                    }

                    rows.push(`| !${mr.iid} | ${who} | ${summary} | ${delivered.result} |`);
                    if (opts.dryRun || opts.show) {
                        texts.push(`### !${mr.iid} ${mr.title} (${delivered.mode})\n\n${facts.comment}`);
                    }
                }

                saveReport(json, report);
                out.println(`| MR | Author | Check (exhaustive) | Result |\n|---|---|---|---|\n${rows.join("\n")}`);
                if (texts.length) {
                    out.println(`\n${texts.join("\n\n")}`);
                }

                progress(
                    `${candidates.length} candidate(s), ${sent} sent, ${failed} failed${opts.dryRun ? " (dry run: facts written to the JSON, nothing sent)" : ""}. Read every touched note back before reporting.`
                );
                if (failed) {
                    process.exitCode = 1;
                }
            }
        );

    cmd.command("mark-review <json>")
        .description(
            "Flag MRs for review regardless of age (needsReview=true), for example young MRs whose change already reached the release target"
        )
        .requiredOption("--iid <n>", "MR iid (repeatable)", collect, [])
        .action(async (json: string, opts: { iid: string[] }) => {
            const report = await loadReport(json);
            const iids = opts.iid.map(requireIid);
            const missing = iids.filter((iid) => !report.mrs.some((m) => m.iid === iid));
            if (missing.length) {
                throw new Error(`Not in this report: ${missing.map((i) => `!${i}`).join(", ")}`);
            }

            let flagged = 0;
            for (const mr of report.mrs) {
                if (iids.includes(mr.iid) && !mr.needsReview) {
                    mr.needsReview = true;
                    flagged++;
                }
            }

            saveReport(json, report);
            progress(
                `${flagged} MR(s) flagged for review (${iids.length - flagged} already were). Fill their review, then merge, post, apply-labels as usual.`
            );
        });

    cmd.command("render <json>")
        .description("Render the filled preflight JSON as a Markdown note")
        .option("--out <file>", "Markdown output path (default: stdout)")
        .option("--ado <id>", "Work-item id for the note frontmatter (repeatable)", collect, [])
        .option("--title <text>", "Note title")
        .option("--allow-unfilled", "Render even when reviewed MRs still have empty review fields")
        .option(
            "--force",
            "Overwrite an existing --out file (default: refuse, so a reviewed note is never lost by accident)"
        )
        .action(async (json: string, opts: RenderOptions) => {
            if (opts.out && existsSync(opts.out) && !opts.force) {
                throw new Error(
                    `${opts.out} exists. Render to a new dated file, or re-read it and pass --force to overwrite.`
                );
            }

            const report = await loadReport(json);
            const config = await loadConfig();
            const unfilled = unfilledReviews(report);
            if (unfilled.length && !opts.allowUnfilled) {
                throw new Error(
                    `${unfilled.length} reviewed MRs have empty review fields: ${unfilled.map((i) => `!${i}`).join(", ")}. Fill them or pass --allow-unfilled.`
                );
            }

            const markdown = renderStaleReport(report, {
                createdAt: localTimestamp(),
                adoTags: opts.ado.map(Number),
                title: opts.title,
                workItemUrlTemplate: config.workItems.urlTemplate,
            });
            if (opts.out) {
                writeFileSync(opts.out, markdown);
                progress(`Wrote ${opts.out} (${unfilled.length} unfilled).`);
            } else {
                out.print(markdown);
            }
        });

    cmd.command("recheck <json>")
        .description(
            "Re-run the content check and compare every filled MR and its work item with the sweep snapshot. Read-only on GitLab; refreshes `shipped`, `labelConflicts` and `closedBug` in the JSON."
        )
        .option("--recommendation <value>", `Only MRs with this recommendation (${RECOMMENDATIONS.join(", ")})`)
        .option("--iid <n>", "Only this MR")
        .option("--cwd <dir>", "Local checkout (default: repoRoot recorded in the JSON)")
        .action(async (json: string, opts: { recommendation?: string; iid?: string; cwd?: string }) => {
            const only = parseIid(opts.iid);
            if (opts.recommendation !== undefined && !RECOMMENDATIONS.includes(opts.recommendation as Recommendation)) {
                throw new Error(
                    `--recommendation must be one of ${RECOMMENDATIONS.join(", ")}, got "${opts.recommendation}"`
                );
            }

            const report = await loadReport(json);
            const config = await loadConfig();
            const cwd = checkoutOf(report, opts.cwd);
            const fetched = gitResult(cwd, ["fetch", "origin", "--prune", "--quiet"]);
            if (fetched.exitCode !== 0) {
                throw new Error(`git fetch origin --prune: ${fetched.stderr}`);
            }

            const api = await reportApi(report);
            const { refs } = await shippedRefsOf(report, { cwd, api, config });
            const context = closedBugContextOf(report, config);
            const targets = report.mrs.filter(
                (mr) =>
                    mr.needsReview &&
                    mr.review.recommendation !== null &&
                    (only === undefined || mr.iid === only) &&
                    (opts.recommendation === undefined || mr.review.recommendation === opts.recommendation)
            );
            if (!targets.length) {
                throw new Error(
                    only === undefined ? "No filled reviews match." : `!${only} has no filled review in this report.`
                );
            }

            const rows = await pool(targets, 4, async (mr) => {
                const before = mr.shipped?.verdict ?? "n/a";
                mr.shipped =
                    mr.git.sourceMissing || mr.git.targetMissing
                        ? null
                        : collectShipped({
                              cwd,
                              sourceRef: `origin/${mr.sourceBranch}`,
                              targetRef: `origin/${mr.targetBranch}`,
                              checkRefs: refs,
                          });
                mr.labelConflicts = mr.shipped
                    ? labelConflicts(mr.labels, mr.shipped, config.stale.mergeLabelPattern)
                    : [];
                mr.closedBug = closedBugOf(mr, context);
                let moved: string;
                try {
                    const live = await fetchMr(api, mr.iid);
                    const result = freshness(mr, live, await liveAdoOf(mr, { cwd, config }));
                    moved = result.changed ? result.details.join("; ") : "no";
                } catch (e: unknown) {
                    moved = `check failed: ${errorMessage(e)}`;
                }

                const flag =
                    mr.review.recommendation === "CLOSE" && mr.shipped?.verdict === "absent"
                        ? "CLOSE with content absent everywhere"
                        : mr.labelConflicts.length
                          ? "label contradicted"
                          : "";

                return `| !${mr.iid} | ${mr.review.recommendation} (${mr.review.confidence ?? "?"} %) | ${before} -> ${mr.shipped?.verdict ?? "n/a"} | ${moved} | ${flag} |`;
            });

            report.shippedRefs = refs;
            saveReport(json, report);
            out.println(
                `| MR | Recommendation | Shipped before -> now | Moved since sweep | Flag |\n|---|---|---|---|---|\n${rows.join("\n")}`
            );
            const flagged = rows.filter((r) => !r.endsWith("|  |")).length;
            progress(
                `${rows.length} rechecked against ${refs.join(", ")}; ${flagged} flagged. Facts refreshed in ${json}; reviews untouched.`
            );
        });

    cmd.command("post <json>")
        .description(
            "Post the drafted comment of ONE reviewed MR and record the note URL in the JSON. Run only after an explicit per-MR approval. With --draft it creates a GitLab draft note instead (visible only to its author until published), and --author allows a batch of drafts."
        )
        .option("--iid <n>", "The single MR iid to post")
        .option(
            "--author <username>",
            "With --draft: every reviewed, drafted-in-JSON, not yet posted MR of this author (repeatable)",
            collect,
            []
        )
        .option("--draft", "Create a GitLab draft note (private to its author) instead of a public note")
        .option("--dry-run", "Print the draft without posting")
        .option("--force", "Post even when the MR or its work item changed since the sweep")
        .action(
            async (
                json: string,
                opts: { iid?: string; author: string[]; draft?: boolean; dryRun?: boolean; force?: boolean }
            ) => {
                const report = await loadReport(json);
                const config = await loadConfig();
                const api = await reportApi(report);

                if (opts.author.length) {
                    await postDraftBatch({
                        json,
                        report,
                        api,
                        authors: opts.author,
                        draft: opts.draft,
                        dryRun: opts.dryRun,
                    });

                    return;
                }

                const iid = parseIid(opts.iid);
                if (iid === undefined) {
                    throw new Error("--iid is required (or --draft with --author for a batch of draft notes).");
                }

                const mr = findReviewedMr(report, iid);
                if (mr.review.draftNoteId && !opts.force) {
                    throw new Error(
                        `!${mr.iid} already has draft note ${mr.review.draftNoteId}; publish it with \`stale-branches publish ${json} --iid ${mr.iid}\`, or pass --force to post a second copy.`
                    );
                }

                const folded = pendingSideComments(mr);
                const body = fullCommentBody(mr);
                progress(
                    `!${mr.iid} ${mr.title}\n${mr.webUrl}\n---\n${body}\n---${folded.length ? `\n(${folded.length} side text(s) folded in: ${folded.map((c) => c.key).join(", ")})` : ""}`
                );
                const live = await fetchMr(api, mr.iid);
                const fresh = freshness(mr, live, await liveAdoOf(mr, { cwd: report.repoRoot, config }));
                if (fresh.changed) {
                    progress(
                        `Changed since the sweep (${report.generatedAt.slice(0, 10)}):\n${fresh.details.map((d) => `  - ${d}`).join("\n")}`
                    );
                    if (!opts.force && !opts.dryRun && !opts.draft) {
                        throw new Error(
                            `!${mr.iid} moved since the sweep; re-read the draft against the changes, then pass --force to post it anyway.`
                        );
                    }
                } else {
                    progress("Nothing changed on the MR or its work item since the sweep.");
                }

                if (opts.dryRun) {
                    progress("Dry run, nothing posted.");

                    return;
                }

                if (opts.draft) {
                    const draft = await postDraftNote(api, String(mr.iid), body);
                    if (!draft.ok) {
                        throw new Error(`Draft note failed for !${mr.iid}: ${draft.status} ${draft.error ?? ""}`);
                    }

                    mr.review.draftNoteId = draft.commentId;
                    mr.review.draftedAt = new Date().toISOString();
                    mr.review.sentBody = body;
                    for (const side of folded) {
                        side.draftNoteId = draft.commentId;
                    }

                    saveReport(json, report);
                    progress(
                        `Draft note ${draft.commentId} created on !${mr.iid}; visible only to you until published.`
                    );

                    return;
                }

                const result = await postComment(api, String(mr.iid), body);
                if (!result.ok) {
                    throw new Error(`POST failed for !${mr.iid}: ${result.status} ${result.error ?? ""}`);
                }

                appendLedger({
                    project: api.project,
                    pr: String(mr.iid),
                    comment_id: result.commentId ?? 0,
                    message: body,
                    ts: new Date().toISOString(),
                });
                const url = markPosted(mr, result.commentId ?? 0);
                for (const side of folded) {
                    side.postedNoteUrl = url;
                    side.postedAt = mr.review.postedAt;
                }

                saveReport(json, report);
                progress(`Posted: ${url}`);
            }
        );

    cmd.command("publish <json>")
        .description(
            "Publish the GitLab draft notes of ONE MR (the review draft from `post --draft` and any side-comment drafts) and record the note URLs. Run only after an explicit per-MR approval."
        )
        .requiredOption("--iid <n>", "The single MR iid")
        .action(async (json: string, opts: { iid: string }) => {
            const iid = requireIid(opts.iid);
            const report = await loadReport(json);
            const mr = report.mrs.find((m) => m.iid === iid);
            if (!mr) {
                throw new Error(`!${iid} is not in this report`);
            }

            const reviewDraft =
                mr.needsReview && mr.review.draftComment && !mr.review.postedNoteUrl
                    ? mr.review.draftNoteId
                    : undefined;
            const sideDrafts = (mr.sideComments ?? []).filter((c) => c.draftNoteId && !c.postedNoteUrl);
            if (!reviewDraft && !sideDrafts.length) {
                throw new Error(`!${mr.iid} has no pending draft note of this flow.`);
            }

            const api = await reportApi(report);
            const published: string[] = [];
            if (reviewDraft) {
                const result = await publishDraftNote(api, String(mr.iid), reviewDraft);
                if (!result.ok) {
                    throw new Error(
                        `Publish failed for !${mr.iid} draft ${reviewDraft}: ${result.status} ${result.error ?? ""}`
                    );
                }

                const draftComment = (mr.review.draftComment ?? "").trim();
                const live = await fetchMr(api, mr.iid);
                const note =
                    findPublishedDraft(mr, live) ??
                    live.notes
                        .filter((n) => !n.system && n.body.trim().startsWith(draftComment))
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
                    null;
                appendLedger({
                    project: api.project,
                    pr: String(mr.iid),
                    comment_id: note?.id ?? 0,
                    message: note?.body ?? draftComment,
                    ts: new Date().toISOString(),
                });
                const url = markPosted(mr, note?.id ?? 0);
                for (const side of mr.sideComments ?? []) {
                    const folded =
                        side.draftNoteId === reviewDraft ||
                        (!side.postedNoteUrl && !side.draftNoteId && (note?.body ?? "").includes(side.body.trim()));
                    if (folded) {
                        side.draftNoteId = undefined;
                        side.postedNoteUrl = url;
                        side.postedAt = mr.review.postedAt;
                    }
                }

                published.push(url);
            }

            for (const side of sideDrafts) {
                if (!side.draftNoteId) {
                    continue;
                }

                const result = await publishDraftNote(api, String(mr.iid), side.draftNoteId);
                if (!result.ok) {
                    throw new Error(
                        `Publish failed for !${mr.iid} side draft ${side.draftNoteId}: ${result.status} ${result.error ?? ""}`
                    );
                }

                const live = await fetchMr(api, mr.iid);
                const note = live.notes
                    .filter((n) => !n.system && n.body.trim() === side.body.trim())
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                side.postedNoteUrl = `${mr.webUrl}#note_${note?.id ?? 0}`;
                side.postedAt = new Date().toISOString();
                side.draftNoteId = undefined;
                appendLedger({
                    project: api.project,
                    pr: String(mr.iid),
                    comment_id: note?.id ?? 0,
                    message: side.body,
                    ts: side.postedAt,
                });
                published.push(side.postedNoteUrl);
            }

            saveReport(json, report);
            progress(`Published: ${published.join(", ")}`);
        });

    cmd.command("manifest <json>")
        .description(
            "Rebuild the sweep manifest: every MR we wrote to, refetched live, with what we sent, whether our stale label is still on, what the author did since, and a status per MR. Read-only on GitLab; writes the manifest JSON."
        )
        .option("--out <file>", "Manifest JSON path (default: <json> with a -manifest suffix)")
        .option("--iid <n>", "Only this MR")
        .option("--status <name>", "Only entries with this status (repeatable)", collect, [])
        .option(
            "--ignore-author <username>",
            "Notes by this user do not count as a reaction (repeatable; the token owner is always ignored)",
            collect,
            []
        )
        .option("--dry-run", "Print the table without writing the manifest")
        .action(
            async (
                json: string,
                opts: { out?: string; iid?: string; status: string[]; ignoreAuthor: string[]; dryRun?: boolean }
            ) => {
                const report = await loadReport(json);
                const config = await loadConfig();
                for (const status of opts.status) {
                    if (!MANIFEST_STATUSES.includes(status as ManifestStatus)) {
                        throw new Error(`--status takes one of ${MANIFEST_STATUSES.join(", ")}, got "${status}"`);
                    }
                }

                const outPath = opts.out ?? json.replace(/(\.json)?$/, "-manifest.json");
                const previous = existsSync(outPath) ? ((await Bun.file(outPath).json()) as StaleManifest) : null;
                const api = await reportApi(report);
                const ignoreAuthors = await ignoredAuthors(api, opts.ignoreAuthor);
                const targets = contactedMrs(report.mrs, parseIid(opts.iid));
                progress(`Refetching ${targets.length} contacted MR(s) and their work items…`);
                const entries = await pool(targets, 4, async (mr) =>
                    manifestEntry(
                        mr,
                        {
                            mr: await fetchMr(api, mr.iid),
                            ado: await liveAdoOf(mr, { cwd: report.repoRoot, config }),
                        },
                        { ignoreAuthors, staleLabel: config.stale.label }
                    )
                );

                const shown = opts.status.length ? entries.filter((e) => opts.status.includes(e.status)) : entries;
                out.println(`${renderManifestTable(shown)}\n\n${manifestSummary(entries)}`);

                const { changed, added } = diffManifest(previous, entries);
                if (previous) {
                    const when = previous.generatedAt.slice(0, 16).replace("T", " ");
                    progress(
                        changed.length
                            ? `Since the manifest of ${when}: ${changed.map((c) => `!${c.iid} ${c.from} → ${c.to}`).join(", ")}`
                            : `No status changed since the manifest of ${when}.`
                    );
                    if (added.length) {
                        progress(`New to the manifest: ${added.map((i) => `!${i}`).join(", ")}`);
                    }
                }

                if (opts.dryRun) {
                    progress(`Dry run: ${outPath} not written.`);

                    return;
                }

                writeFileSync(
                    outPath,
                    `${SafeJSON.stringify(buildManifest({ source: json, entries, previous }), null, 2)}\n`
                );
                progress(`${entries.length} entries written to ${outPath}`);
            }
        );

    cmd.command("followup <json>")
        .description(
            "Phase 2 list: every notified MR (posted comment or applied label), what moved since, and which are close candidates. Read-only on GitLab."
        )
        .option("--after-days <n>", "Days of silence before an MR is a close candidate", "7")
        .option("--iid <n>", "Only this MR")
        .option(
            "--ignore-author <username>",
            "Notes by this user do not count as activity (repeatable; the token owner is always ignored)",
            collect,
            []
        )
        .action(async (json: string, opts: { afterDays: string; iid?: string; ignoreAuthor: string[] }) => {
            const report = await loadReport(json);
            const config = await loadConfig();
            const api = await reportApi(report);
            const ignoreAuthors = await ignoredAuthors(api, opts.ignoreAuthor);
            const unreconciled = report.mrs.filter((mr) => mr.review.draftNoteId && !mr.review.postedAt);
            let reconciled = 0;
            await pool(unreconciled, 4, async (mr) => {
                const note = findPublishedDraft(mr, await fetchMr(api, mr.iid));
                if (note) {
                    markPosted(mr, note.id, new Date(note.createdAt));
                    reconciled++;
                }
            });
            if (reconciled) {
                saveReport(json, report);
                progress(`${reconciled} draft note(s) were published in GitLab since; postedAt recorded.`);
            }

            const targets = notifiedMrs(report.mrs, parseIid(opts.iid));
            if (!targets.length) {
                progress("No notified MRs in this report.");

                return;
            }

            const rows = await pool(targets, 4, async (mr) =>
                followupRow(
                    mr,
                    { mr: await fetchMr(api, mr.iid), ado: await liveAdoOf(mr, { cwd: report.repoRoot, config }) },
                    { afterDays: Number(opts.afterDays), ignoreAuthors }
                )
            );
            rows.sort((a, b) => a.iid - b.iid);
            out.println(renderFollowupTable(rows));
            const candidates = rows.filter((r) => r.candidate);
            progress(
                `${rows.length} notified; ${candidates.length} close candidate(s) after ${opts.afterDays} silent day(s)${candidates.length ? `: ${candidates.map((r) => `!${r.iid}`).join(", ")}` : ""}. Close each with \`stale-branches close <json> --iid <n>\` after its own approval.`
            );
        });

    cmd.command("close <json>")
        .description(
            "Phase 2: close ONE notified MR and record closedAt in the JSON. Run only after an explicit per-MR approval."
        )
        .requiredOption("--iid <n>", "The single MR iid to close")
        .option("--after-days <n>", "Days of silence required", "7")
        .option(
            "--ignore-author <username>",
            "Notes by this user do not count as activity (repeatable; the token owner is always ignored)",
            collect,
            []
        )
        .option("--dry-run", "Show the activity check without closing")
        .option("--force", "Close even when the MR had activity or was notified less than --after-days ago")
        .option(
            "--delete-branch",
            "After closing, delete the source branch on origin (refused when protected or still used by another open MR)"
        )
        .action(
            async (
                json: string,
                opts: {
                    iid: string;
                    afterDays: string;
                    ignoreAuthor: string[];
                    dryRun?: boolean;
                    force?: boolean;
                    deleteBranch?: boolean;
                }
            ) => {
                const report = await loadReport(json);
                const config = await loadConfig();
                const [mr] = notifiedMrs(report.mrs, requireIid(opts.iid));
                if (!mr) {
                    throw new Error(`!${opts.iid} was not notified by this flow`);
                }

                const api = await reportApi(report);
                const ignoreAuthors = await ignoredAuthors(api, opts.ignoreAuthor);
                const row = followupRow(
                    mr,
                    { mr: await fetchMr(api, mr.iid), ado: await liveAdoOf(mr, { cwd: report.repoRoot, config }) },
                    { afterDays: Number(opts.afterDays), ignoreAuthors }
                );
                progress(
                    `!${mr.iid} ${mr.title}\n${mr.webUrl}\nNotified ${row.notifiedAt.slice(0, 10)} (${row.daysSince} d ago), live state ${row.liveState}\nActivity since: ${row.activity.length ? row.activity.join("; ") : "none"}`
                );
                if (row.liveState !== "opened") {
                    throw new Error(`!${mr.iid} is already ${row.liveState}; nothing to close.`);
                }

                if (!row.candidate && !opts.force) {
                    throw new Error(
                        `!${mr.iid} is not a close candidate (${row.activity.length ? "activity since the notification" : `only ${row.daysSince} of ${opts.afterDays} silent days`}). Pass --force after reading the activity.`
                    );
                }

                if (opts.deleteBranch) {
                    // The sweep JSON and the live MR list: an MR opened since the sweep is only in the latter.
                    const users = [
                        ...new Set([
                            ...branchUsers(mr.sourceBranch, mr, report.mrs).map((u) => u.iid),
                            ...(await liveBranchUsers(api, mr.sourceBranch)).filter((iid) => iid !== mr.iid),
                        ]),
                    ];
                    if (users.length) {
                        throw new Error(
                            `Branch ${mr.sourceBranch} is still used by open ${users.map((iid) => `!${iid}`).join(", ")}; close those first or drop --delete-branch.`
                        );
                    }

                    const isProtected = await branchProtected(api, mr.sourceBranch);
                    if (isProtected === true) {
                        throw new Error(`Branch ${mr.sourceBranch} is protected; not deleting.`);
                    }

                    progress(
                        isProtected === null
                            ? `Branch ${mr.sourceBranch} no longer exists on origin.`
                            : `Branch ${mr.sourceBranch} is unprotected and used by no other open MR.`
                    );
                }

                if (opts.dryRun) {
                    progress("Dry run, nothing closed.");

                    return;
                }

                const result = await closeMr(api, mr.iid);
                if (!result.ok) {
                    throw new Error(`Close failed for !${mr.iid}: ${result.status} ${result.error ?? ""}`);
                }

                markClosed(mr);
                saveReport(json, report);
                progress(`Closed !${mr.iid} (${mr.webUrl}).`);

                if (opts.deleteBranch) {
                    const deleted = await deleteUnusedBranch({
                        branch: mr.sourceBranch,
                        closedIid: mr.iid,
                        ops: branchDeleteOps(api),
                    });

                    if (deleted.outcome === "missing") {
                        progress(`Branch ${mr.sourceBranch} no longer exists on origin.`);
                    } else if (deleted.outcome === "in-use") {
                        throw new Error(
                            `Closed, but not deleting ${mr.sourceBranch}: open ${deleted.users.map((iid) => `!${iid}`).join(", ")} started using it.`
                        );
                    } else if (deleted.outcome === "protected") {
                        throw new Error(`Closed, but not deleting ${mr.sourceBranch}: it is protected now.`);
                    } else if (deleted.outcome === "failed") {
                        throw new Error(
                            `Closed, but deleting ${mr.sourceBranch} failed: ${deleted.status} ${deleted.error ?? ""}`
                        );
                    } else {
                        markBranchDeleted(mr);
                        saveReport(json, report);
                        progress(`Deleted origin/${mr.sourceBranch}.`);
                    }
                }
            }
        );

    cmd.command("apply-labels <json>")
        .description(
            "Apply review.labels of every pending reviewed MR (or one --iid), logging labels before and after. Run only after the dry-run table was approved."
        )
        .option("--iid <n>", "Apply only this MR")
        .option("--dry-run", "Fetch current labels and print the planned table without changing anything")
        .action(async (json: string, opts: { iid?: string; dryRun?: boolean }) => {
            const report = await loadReport(json);
            const pending = pendingLabels(report, parseIid(opts.iid));
            if (!pending.length) {
                progress("No pending label changes.");

                return;
            }

            const api = await reportApi(report);
            const known = new Set(await projectLabelNames(api));
            const unknown = [...new Set(pending.flatMap((p) => p.add).filter((l) => !known.has(l)))];
            if (unknown.length) {
                throw new Error(`Unknown project label(s): ${unknown.join(", ")}. Fix review.labels in ${json}.`);
            }

            const changes = await pool(pending, 4, async ({ mr, add, remove }): Promise<LabelChange> => {
                const live = await fetchMrLabels(api, mr.iid);
                const before = [...live.labels].sort();
                const expected = expectedLabels(before, add, remove);
                const base = { iid: mr.iid, title: mr.title, webUrl: mr.webUrl, before, expected };
                if (sameLabels(before, expected)) {
                    markLabelsApplied(mr, { before, after: before });

                    return { ...base, after: before, ok: true, unchanged: true, status: 0 };
                }

                if (opts.dryRun) {
                    return { ...base, after: null, ok: true, unchanged: false, status: 0 };
                }

                const result = await putMrLabels(api, { iid: mr.iid, add, remove });
                const after = result.labels ? [...result.labels].sort() : null;
                appendLabelLedger({
                    ts: new Date().toISOString(),
                    project: api.project,
                    iid: mr.iid,
                    add,
                    remove,
                    before,
                    after,
                    ok: result.ok,
                    dryRun: false,
                    error: result.error,
                });
                if (result.ok && after) {
                    markLabelsApplied(mr, { before, after });
                }

                const mismatch = Boolean(result.ok && after && !sameLabels(after, expected));

                return {
                    ...base,
                    after,
                    ok: result.ok && !mismatch,
                    unchanged: false,
                    status: result.status,
                    error: mismatch ? `expected ${expected.join(", ")}` : result.error,
                };
            });

            out.println(renderChangeTable(changes));
            const failed = changes.filter((c) => !c.ok);
            const unchanged = changes.filter((c) => c.unchanged);
            if (!opts.dryRun || unchanged.length) {
                saveReport(json, report);
            }

            progress(
                `${opts.dryRun ? "Would change" : "Changed"}: ${changes.length - unchanged.length - failed.length}  Unchanged: ${unchanged.length}  Failed: ${failed.length}${opts.dryRun ? "  (dry run, nothing sent)" : ""}`
            );
            if (failed.length) {
                process.exitCode = 1;
            }
        });

    return cmd;
}

/** `post --draft --author`: a batch of private draft notes, one per MR of those authors. */
async function postDraftBatch(options: {
    json: string;
    report: StaleReport;
    api: ProjectApi;
    authors: string[];
    draft?: boolean;
    dryRun?: boolean;
}): Promise<void> {
    const { json, report, api } = options;
    if (!options.draft) {
        throw new Error(
            "--author works only with --draft: public comments go out one MR at a time, each after its own approval."
        );
    }

    const targets = report.mrs.filter(
        (mr) =>
            mr.needsReview &&
            mr.review.draftComment &&
            !mr.review.postedNoteUrl &&
            !mr.review.draftNoteId &&
            options.authors.includes(mr.author.username)
    );
    if (!targets.length) {
        progress("No MR of those authors has an undrafted, unposted comment.");

        return;
    }

    const rows: string[] = [];
    for (const mr of targets) {
        if (options.dryRun) {
            rows.push(`| !${mr.iid} | ${mr.author.username} | ${mr.review.recommendation} | dry run |`);
            continue;
        }

        const folded = pendingSideComments(mr);
        const sent = fullCommentBody(mr);
        const result = await postDraftNote(api, String(mr.iid), sent);
        if (result.ok && result.commentId) {
            mr.review.draftNoteId = result.commentId;
            mr.review.draftedAt = new Date().toISOString();
            mr.review.sentBody = sent;
            for (const side of folded) {
                side.draftNoteId = result.commentId;
            }
        }

        rows.push(
            `| !${mr.iid} | ${mr.author.username} | ${mr.review.recommendation} | ${result.ok ? `draft ${result.commentId}` : `FAIL ${result.status} ${result.error ?? ""}`} |`
        );
    }

    if (!options.dryRun) {
        saveReport(json, report);
    }

    out.println(`| MR | Author | Recommendation | Result |\n|---|---|---|---|\n${rows.join("\n")}`);
    const failed = rows.filter((r) => r.includes("| FAIL")).length;
    progress(
        options.dryRun
            ? `Dry run: ${rows.length} draft note(s) would be created, nothing sent.`
            : `${rows.length - failed} draft note(s) created, ${failed} failed. They are visible only to you until published: \`stale-branches publish <json> --iid <n>\` or the GitLab review UI.`
    );
    if (failed) {
        process.exitCode = 1;
    }
}
