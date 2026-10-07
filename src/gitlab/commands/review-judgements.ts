/**
 * `gitlab pr <iid> review skeleton | check`: the judgements file of a review.
 *
 *   tools gitlab pr 42 review skeleton --give --file notes/MR42-judgements.md
 *   tools gitlab pr 42 review check --file notes/MR42-judgements.md
 *   tools gitlab pr 42 review render --file notes/MR42-judgements.md --open     (full layout, to a file)
 *   tools gitlab pr 42 review render --file notes/MR42-judgements.md --digest   (the chat view)
 *
 * `skeleton` writes every judgeable item's heading (id, `discussion …` / `draft …`, anchor) and empty
 * fields; the agent fills the file in one write. `check` exits 1 with line numbers while anything would
 * render wrong or post to the wrong place.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:process";
import { pickMode } from "@app/gitlab/commands/pr-review";
import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import { loadConfig } from "@app/gitlab/lib/config";
import { parseJudgementsFile, reportPathFor } from "@app/gitlab/lib/judgements";
import { checkJudgements, skeletonJson, skeletonText } from "@app/gitlab/lib/judgements-check";
import {
    alreadyPosted,
    blockingErrors,
    describeStep,
    ledgerPath,
    loadLedger,
    type PostStep,
    pendingDraftFor,
    planPost,
    readBack,
    saveLedger,
    stepHash,
    unverifiedSteps,
} from "@app/gitlab/lib/judgements-post";
import {
    proposalFromJudgements,
    type RenderContext,
    renderDigest,
    renderFull,
    renderItems,
} from "@app/gitlab/lib/judgements-render";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import { fetchMrDiffs } from "@app/gitlab/lib/pr-review";
import {
    anchoredPosition,
    type DraftSummary,
    type DraftWriteResult,
    deleteDraft,
    fetchDiffRefs,
    fetchDrafts,
    rewordDraft,
    writeDraftReply,
    writePositionedDraft,
    writeTopLevelDraft,
} from "@app/gitlab/lib/review-drafts";
import { judgementsPath, reviewItems } from "@app/gitlab/lib/review-items";
import { collectThreadContext } from "@app/gitlab/lib/review-render";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface JudgementOptions extends TargetOptions {
    file?: string;
    format?: string;
    print?: boolean;
    receive?: boolean;
    give?: boolean;
    force?: boolean;
}

interface PostOptions extends JudgementOptions {
    do?: string;
    answers?: string;
    apply?: boolean;
    agent: string;
}

interface RenderOptions extends JudgementOptions {
    digest?: boolean;
    item?: string;
    proposal?: boolean;
    out?: string;
    open?: boolean;
    repo?: string;
    agent: string;
    contextLines?: string;
}

const MR_ARG = "MR iid (the number after `pr`)";

function withJudgementFile(cmd: Command): Command {
    return withProject(
        cmd
            .argument("<iid>", MR_ARG)
            .option("--file <path>", "The judgements file (default: one per MR in the temp folder)")
            .option("--receive", "Judge the threads on my MR")
            .option("--give", "Judge my own comments on someone else's MR, and add new findings")
    );
}

export function registerReviewJudgements(review: Command): void {
    withJudgementFile(
        review
            .command("skeleton")
            .description("Write the judgements file: every judgeable item's heading and empty fields")
            .option("--force", "Overwrite an existing file")
            .option("--format <md|json>", "md (default) or json; a --file ending in .json picks json")
            .option("--print", "Print the skeleton instead of writing the file")
    ).action(runSkeleton);

    withJudgementFile(
        review.command("check").description("Check a filled judgements file; exit 1 with line numbers on any error")
    ).action(runCheck);

    withJudgementFile(
        review
            .command("render")
            .description(
                "The report from the judgements file: the full layout to a file (default), or --digest, --item, --proposal"
            )
            .option("--digest", "Print the chat view: one card per item, every quoted comment in full")
            .option("--item <ids>", "Print these items in the full layout, e.g. T03,D01")
            .option("--proposal", `Print the review proposal JSON for \`${toolCommand("hub proposal push", "-")}\``)
            .option("--out <path>", "Where the full layout goes (default: beside the judgements file, -report.md)")
            .option("--open", "Open the full layout in Genesis Markdown")
            .option(
                "--repo <checkout>",
                "The checkout file links and code views come from (default: the current directory)"
            )
            .option("--agent <name>", "Who signs an answer in your own thread: [90%] <name>: …", "Opus")
            .option("--context-lines <n>", "Lines around each thread's anchor (default: review.fetch.contextLines)")
    ).action(runRender);
}

async function target(iid: string, opts: JudgementOptions) {
    if (!/^\d+$/.test(iid)) {
        throw new Error(`The MR iid must be a positive integer; got "${iid}".`);
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const mode = await pickMode(iid, opts);
    const file = resolve(opts.file ?? judgementsPath({ host: api.host, project: api.project, iid: Number(iid) }));

    return { api, mode, file };
}

async function runSkeleton(iid: string, opts: JudgementOptions): Promise<void> {
    const format = opts.format ?? (opts.file?.toLowerCase().endsWith(".json") ? "json" : "md");

    if (format !== "md" && format !== "json") {
        throw new Error(`--format must be md or json, got "${format}".`);
    }

    const { api, mode, file: given } = await target(iid, opts);
    const file = format === "json" && !opts.file ? given.replace(/\.md$/, ".json") : given;

    if (!opts.print && existsSync(file) && !opts.force) {
        throw new Error(`${file} exists; pass --force to start over, or edit it.`);
    }

    const items = await reviewItems(api, Number(iid), { mode, persist: true });
    const input = { iid: Number(iid), mode, headSha: items.headSha, items: items.known };
    const body = format === "json" ? `${SafeJSON.stringify(skeletonJson(input), null, 2)}\n` : skeletonText(input);

    if (opts.print) {
        out.print(body);
        return;
    }

    writeFileSync(file, body);
    progress(`ℹ  ${items.known.length} item(s) to judge → ${file}`);
    progress(`ℹ  then: ${toolCommand("gitlab pr", iid, "review", "check", `--${mode}`, "--file", file)}`);
}

async function runCheck(iid: string, opts: JudgementOptions): Promise<void> {
    const { api, mode, file } = await target(iid, opts);

    if (!existsSync(file)) {
        throw new Error(
            `${file} does not exist; write it with \`${toolCommand("gitlab pr", iid, "review", "skeleton")}\`.`
        );
    }

    const [items, files, config] = await Promise.all([
        reviewItems(api, Number(iid), { mode, persist: false }),
        mode === "give" ? fetchMrDiffs(api, Number(iid)) : Promise.resolve(null),
        loadConfig(),
    ]);
    const result = checkJudgements({
        judgements: parseJudgementsFile(readFileSync(file, "utf-8"), file),
        known: items.known,
        files,
        rules: config.review.draftRules,
        iid: Number(iid),
    });

    for (const warning of result.warnings) {
        out.println(`⚠  ${warning.id}${warning.line ? ` (line ${warning.line})` : ""}: ${warning.message}`);
    }

    for (const error of result.errors) {
        out.println(`✗  ${error.id} (line ${error.line}): ${error.message}`);
    }

    if (result.errors.length > 0) {
        out.println(`\n${result.errors.length} error(s) in ${file}`);
        process.exitCode = 1;

        return;
    }

    out.println(`✓  ${file} is ready to render and post`);
}

/** `comments post`: the judgements file's actions as drafts, a dry run until --apply. */
export function registerCommentsPost(comments: Command): void {
    withJudgementFile(
        comments
            .command("post")
            .description("Post what the judgements file decided: a dry run until --apply, then read back")
            .option("--do <ids>", "Run each item's Action, e.g. T01,D03,N01")
            .option("--answers <ids>", "Post each item's Proposed answer into my own thread (a D item after publish)")
            .option("--apply", "Post for real")
            .option("--agent <name>", "Who signs an answer in your own thread: [90%] <name>: …", "Opus")
    ).action(runPost);
}

/** Everything a render needs about the MR, read once. */
async function renderContext(
    iid: string,
    mode: "receive" | "give",
    opts: RenderOptions,
    api: Awaited<ReturnType<typeof resolveProjectApi>>
): Promise<RenderContext> {
    const repoPath = resolve(opts.repo ?? process.cwd());
    const config = await loadConfig();
    const parsedContext = Number.parseInt(opts.contextLines ?? "", 10);
    const contextLines = Number.isNaN(parsedContext) ? config.review.fetch.contextLines : Math.max(0, parsedContext);
    const items = await reviewItems(api, Number(iid), { mode, persist: false });
    const threadIds = new Set(
        items.known.flatMap((item) => (item.pair.kind === "discussion" ? [item.pair.value] : []))
    );
    const [mr, refs, files, context] = await Promise.all([
        fetchMr(api, Number(iid)),
        fetchDiffRefs(api, iid),
        fetchMrDiffs(api, Number(iid)),
        collectThreadContext({
            api,
            iid,
            cwd: repoPath,
            fetchRemote: true,
            onWarn: (message) => progress(`⚠  ${message}`),
            include: (d) => threadIds.has(d.id ?? ""),
        }),
    ]);

    return {
        iid: Number(iid),
        mode,
        mr: {
            host: api.host,
            project: api.project,
            title: mr.title,
            webUrl: mr.webUrl,
            sourceBranch: mr.sourceBranch,
            targetBranch: mr.targetBranch,
            headSha: items.headSha,
            baseSha: refs.base_sha,
        },
        repoPath,
        known: items.known,
        threads: new Map(context.selected.map((d) => [d.id ?? "", d])),
        threadOpts: {
            mrIid: iid,
            project: api.project,
            cwd: repoPath,
            contextLines,
            anchorViews: context.anchorViews,
            tip: context.tip,
            refs: new Map(items.known.map((item) => [item.pair.value, item.id])),
        },
        drafts: items.drafts,
        discussions: items.discussions,
        files,
        agent: opts.agent,
        // The review layouts show at least 10 lines on each side of an anchor.
        contextLines: Math.max(10, contextLines),
    };
}

async function runRender(iid: string, opts: RenderOptions): Promise<void> {
    const { api, mode, file } = await target(iid, opts);

    if (!existsSync(file)) {
        throw new Error(
            `${file} does not exist; write it with \`${toolCommand("gitlab pr", iid, "review", "skeleton")}\`.`
        );
    }

    const judgements = parseJudgementsFile(readFileSync(file, "utf-8"), file);
    const ctx = await renderContext(iid, mode, opts, api);

    if (opts.proposal) {
        out.result(proposalFromJudgements(judgements, ctx));
        return;
    }

    if (opts.digest) {
        out.print(renderDigest(judgements, ctx));
        return;
    }

    if (opts.item) {
        out.print(renderItems(judgements, ctx, opts.item.split(",")));
        return;
    }

    const reportPath = resolve(opts.out ?? reportPathFor(file));

    if (reportPath === resolve(file)) {
        throw new Error(`The report would overwrite the judgements file ${file}; name another path with --out.`);
    }

    writeFileSync(reportPath, renderFull(judgements, ctx));
    progress(`ℹ  full layout → ${reportPath}`);

    if (opts.open && platform === "darwin") {
        const link = `genesis-md://open?path=${encodeURIComponent(reportPath)}`;
        const opened = Bun.spawnSync(["open", link]);

        if (opened.exitCode !== 0) {
            progress(`⚠  could not open ${link}: ${opened.stderr.toString().trim()}`);
        }
    }

    out.println(reportPath);
}

export async function runStep(
    api: Awaited<ReturnType<typeof resolveProjectApi>>,
    iid: string,
    step: PostStep,
    context: { drafts: DraftSummary[]; files: Awaited<ReturnType<typeof fetchMrDiffs>> }
): Promise<DraftWriteResult> {
    const create = async (
        anchor: Extract<PostStep, { kind: "comment" }>["anchor"],
        body: string
    ): Promise<DraftWriteResult> => {
        // A create that landed before a failed run is pending already: reuse it, never post a second copy.
        const pending = pendingDraftFor({
            drafts: context.drafts,
            anchor,
            body,
            except: step.kind === "move" ? step.draftId : undefined,
        });

        if (pending) {
            return { ok: true, action: "updated", draftId: pending.id, discussionId: null };
        }

        if (anchor.top) {
            return writeTopLevelDraft(api, iid, body);
        }

        const position = anchoredPosition(context.files, anchor.path, anchor.line, anchor.side);

        return typeof position === "string"
            ? { ok: false, action: "failed", error: position }
            : writePositionedDraft(api, { iid, body, position });
    };

    switch (step.kind) {
        case "reply":
            return writeDraftReply(api, {
                iid,
                discussionId: step.discussionId,
                body: step.body,
                resolve: step.resolve,
                knownDrafts: context.drafts,
            });
        case "delete": {
            const removed = await deleteDraft(api, iid, step.draftId);

            return removed.ok
                ? { ok: true, action: "updated", draftId: step.draftId }
                : { ok: false, action: "failed", error: removed.error };
        }
        case "reword":
            return rewordDraft(api, { iid, draftId: step.draftId, body: step.body });
        case "comment":
            return create(step.anchor, step.body);
        case "move": {
            // The new draft first: a failed create leaves the old one in place, never neither.
            const created = await create(step.anchor, step.body);

            if (!created.ok) {
                return created;
            }

            const removed = await deleteDraft(api, iid, step.draftId);

            if (removed.ok) {
                return created;
            }

            // Undo the create, so a re-run starts from the old draft alone instead of adding a second copy.
            const undone =
                created.draftId === undefined
                    ? { ok: false, error: "GitLab returned no id for it" }
                    : await deleteDraft(api, iid, created.draftId);

            return {
                ...created,
                ok: false,
                error: undone.ok
                    ? `deleting draft ${step.draftId} failed (${removed.error}); the new draft ${created.draftId} was removed again, so nothing changed`
                    : `the new draft ${created.draftId} exists, but deleting draft ${step.draftId} failed (${removed.error}) and removing the new one failed too (${undone.error}). Delete one of them with ${toolCommand("gitlab pr", iid, "comments", "delete", String(created.draftId ?? "<id>"))} before running again.`,
            };
        }
    }
}

async function runPost(iid: string, opts: PostOptions): Promise<void> {
    const ids = (opts.do ?? "").split(",");
    const answers = (opts.answers ?? "").split(",");

    if (!opts.do && !opts.answers) {
        throw new Error(
            "Name what to post: --do T01,N01 (each item's Action) and/or --answers D05 (answers in my own threads)."
        );
    }

    const { api, mode, file } = await target(iid, opts);

    if (!existsSync(file)) {
        throw new Error(
            `${file} does not exist; write it with \`${toolCommand("gitlab pr", iid, "review", "skeleton")}\`.`
        );
    }

    const judgements = parseJudgementsFile(readFileSync(file, "utf-8"), file);
    const [items, files, config] = await Promise.all([
        reviewItems(api, Number(iid), { mode, persist: Boolean(opts.apply) }),
        fetchMrDiffs(api, Number(iid)),
        loadConfig(),
    ]);
    const selected = new Set([...ids, ...answers].map((id) => id.trim().toUpperCase()).filter(Boolean));
    const check = checkJudgements({
        judgements,
        known: items.known,
        files,
        rules: config.review.draftRules,
        iid: Number(iid),
    });
    const blocking = blockingErrors({
        errors: check.errors,
        selected,
        itemIds: new Set(judgements.items.map((item) => item.id)),
    });
    const plan = planPost({ judgements, known: items.known, ids, answers, agent: opts.agent });
    const problems = [...blocking.map((e) => ({ id: e.id, message: e.message })), ...plan.errors];

    if (problems.length > 0) {
        for (const problem of problems) {
            out.println(`✗  ${problem.id}: ${problem.message}`);
        }

        out.println(
            `\nNothing was posted. Fix the file and run \`${toolCommand("gitlab pr", iid, "review", "check", `--${mode}`, "--file", file)}\`.`
        );
        process.exitCode = 1;

        return;
    }

    const ledgerFile = ledgerPath({ host: api.host, project: api.project, iid: Number(iid) });
    const ledger = loadLedger(ledgerFile);
    const todo = plan.steps.filter((step) => !alreadyPosted(ledger, step));
    const recheck = unverifiedSteps(ledger, plan.steps);

    for (const step of plan.steps) {
        const landed = alreadyPosted(ledger, step);
        const note = !landed
            ? ""
            : landed.verified === false
              ? `  (posted ${landed.at}, not read back yet: read back again, not posted again)`
              : `  (already posted ${landed.at}, skipped)`;
        out.println(`${describeStep(step)}${note}`);
    }

    for (const skip of plan.skipped) {
        out.println(`${skip.id.padEnd(4)} skipped       ${skip.reason}`);
    }

    if (!opts.apply) {
        const flags = [opts.do ? ["--do", opts.do] : [], opts.answers ? ["--answers", opts.answers] : []].flat();
        out.println(
            `\nDry run, nothing posted. Post with: ${toolCommand("gitlab pr", iid, "comments", "post", `--${mode}`, "--file", file, ...flags, "--apply")}`
        );
        return;
    }

    const drafts = await fetchDrafts(api, iid);
    const draftIds = new Map<string, number>();

    for (const step of recheck) {
        const draftId = ledger[step.id]?.draftId;

        if (draftId !== undefined) {
            draftIds.set(step.id, draftId);
        }
    }

    for (const step of todo) {
        const result = await runStep(api, iid, step, { drafts, files });

        if (!result.ok) {
            out.println(
                `\n⛔ ${step.id}: ${result.error}\nStopped; the steps before it were posted. Run the same command again after the fix: posted steps are skipped.`
            );
            process.exitCode = 1;

            return;
        }

        if (result.draftId !== undefined) {
            draftIds.set(step.id, result.draftId);
        }

        ledger[step.id] = {
            kind: step.kind,
            bodyHash: stepHash(step),
            at: new Date().toISOString(),
            draftId: result.draftId,
            verified: false,
        };
        saveLedger(ledgerFile, ledger);
    }

    const after = await fetchDrafts(api, iid);
    const checked = [...recheck, ...todo];
    const mismatches: string[] = [];

    for (const step of checked) {
        const problem = readBack(step, after, draftIds);

        if (problem) {
            mismatches.push(`${step.id}: ${problem}`);
            continue;
        }

        ledger[step.id] = { ...ledger[step.id], verified: true };
    }

    saveLedger(ledgerFile, ledger);

    if (mismatches.length > 0) {
        out.println(
            `\n⛔ read back:\n${mismatches.map((line) => `  ${line}`).join("\n")}\nThese steps stay unverified: a re-run reads them back again and does not post them twice.`
        );
        process.exitCode = 1;

        return;
    }

    out.println(
        `\n✅ ${checked.length} step(s) posted as drafts and read back on !${iid}. Publish with \`${toolCommand("gitlab pr", iid, "comments", "publish")}\` when the user asks.`
    );
}
