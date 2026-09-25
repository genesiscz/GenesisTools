#!/usr/bin/env bun

import { registerActivity } from "@app/gitlab/commands/activity";
import { registerAnalyzeProject } from "@app/gitlab/commands/analyze-project";
import { registerAnalyzeUser } from "@app/gitlab/commands/analyze-user";
import { registerBatchComment } from "@app/gitlab/commands/batch-comment";
import { registerBatchLabel } from "@app/gitlab/commands/batch-label";
import { registerFetchReview } from "@app/gitlab/commands/fetch-review";
import { registerPrReview } from "@app/gitlab/commands/pr-review";
import { registerReviewDrafts } from "@app/gitlab/commands/review-drafts";
import { registerSearchByFile } from "@app/gitlab/commands/search-by-file";
import { registerStaleBranches } from "@app/gitlab/commands/stale-branches";
import { loadConfig } from "@app/gitlab/lib/config";
import { errorMessage } from "@app/gitlab/lib/http";
import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

const program = new Command();

program
    .name("gitlab")
    .description(
        "GitLab for any instance: per-day activity, user and project reports, MR review threads and drafts, reviewing someone else's MR, batch comments and labels, open MRs by file, stale-MR cleanup"
    );

registerActivity(program);
registerAnalyzeUser(program);
registerAnalyzeProject(program);
registerBatchComment(program);
registerBatchLabel(program);
registerFetchReview(program);
registerPrReview(program);
registerReviewDrafts(program);
registerSearchByFile(program);
registerStaleBranches(program);

// Every renderer reads the configured date style, so the config loads before any command runs.
program.hook("preAction", async () => {
    await loadConfig();
});

if (import.meta.main) {
    try {
        await runTool(program, { tool: "gitlab" });
    } catch (error) {
        logger.debug({ error }, "gitlab: command failed");
        out.printlnErr(`Error: ${errorMessage(error)}`);
        await out.flush();
        process.exitCode = 1;
    }
}
