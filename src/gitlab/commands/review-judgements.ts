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
import { parseJudgements } from "@app/gitlab/lib/judgements";
import { checkJudgements, skeletonText } from "@app/gitlab/lib/judgements-check";
import {
    proposalFromJudgements,
    type RenderContext,
    renderDigest,
    renderFull,
    renderItems,
} from "@app/gitlab/lib/judgements-render";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import { fetchMrDiffs } from "@app/gitlab/lib/pr-review";
import { fetchDiffRefs } from "@app/gitlab/lib/review-drafts";
import { judgementsPath, reviewItems } from "@app/gitlab/lib/review-items";
import { collectThreadContext } from "@app/gitlab/lib/review-render";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface JudgementOptions extends TargetOptions {
    file?: string;
    receive?: boolean;
    give?: boolean;
    force?: boolean;
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
            .option("--proposal", "Print the review proposal JSON for `tools hub proposal push -`")
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
    const { api, mode, file } = await target(iid, opts);

    if (existsSync(file) && !opts.force) {
        throw new Error(`${file} exists; pass --force to start over, or edit it.`);
    }

    const items = await reviewItems(api, Number(iid), mode);
    writeFileSync(file, skeletonText({ iid: Number(iid), mode, headSha: items.headSha, items: items.known }));
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
        reviewItems(api, Number(iid), mode),
        mode === "give" ? fetchMrDiffs(api, Number(iid)) : Promise.resolve(null),
        loadConfig(),
    ]);
    const result = checkJudgements({
        judgements: parseJudgements(readFileSync(file, "utf-8")),
        known: items.known,
        files,
        rules: config.review.draftRules,
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
    const items = await reviewItems(api, Number(iid), mode);
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
        files,
        agent: opts.agent,
    };
}

function reportPathFor(file: string): string {
    return file.replace(/(-judgements)?\.md$/, "-report.md");
}

async function runRender(iid: string, opts: RenderOptions): Promise<void> {
    const { api, mode, file } = await target(iid, opts);

    if (!existsSync(file)) {
        throw new Error(
            `${file} does not exist; write it with \`${toolCommand("gitlab pr", iid, "review", "skeleton")}\`.`
        );
    }

    const judgements = parseJudgements(readFileSync(file, "utf-8"));
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
