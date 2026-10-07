/**
 * `gitlab pr <iid> review skeleton | check`: the judgements file of a review.
 *
 *   tools gitlab pr 42 review skeleton --give --file notes/MR42-judgements.md
 *   tools gitlab pr 42 review check --file notes/MR42-judgements.md
 *
 * `skeleton` writes every judgeable item's heading (id, `discussion …` / `draft …`, anchor) and empty
 * fields; the agent fills the file in one write. `check` exits 1 with line numbers while anything would
 * render wrong or post to the wrong place.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickMode } from "@app/gitlab/commands/pr-review";
import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import { loadConfig } from "@app/gitlab/lib/config";
import { parseJudgements } from "@app/gitlab/lib/judgements";
import { checkJudgements, skeletonText } from "@app/gitlab/lib/judgements-check";
import { fetchMrDiffs } from "@app/gitlab/lib/pr-review";
import { judgementsPath, reviewItems } from "@app/gitlab/lib/review-items";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface JudgementOptions extends TargetOptions {
    file?: string;
    receive?: boolean;
    give?: boolean;
    force?: boolean;
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
