/**
 * Open MRs that touch specific files, through GitLab GraphQL.
 *
 *   tools gitlab pr touching bun.lock
 *   tools gitlab pr touching bun.lock package.json --json
 *
 * Progress goes to stderr, results to stdout.
 */

import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { getProject, resolveProjectApi } from "@app/gitlab/lib/client";
import { formatSearchJson, formatSearchText, searchMrsByFiles } from "@app/gitlab/lib/search-by-file";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Options extends TargetOptions {
    json?: boolean;
}

export function registerTouching(pr: Command): Command {
    return withProject(
        pr
            .command("touching")
            .description("Open MRs that change these files (GitLab GraphQL)")
            .argument("<files...>", "File paths to match, exact or as a path suffix")
            .option("--json", "Emit JSON instead of human-readable text")
    ).action(runSearchByFile);
}

async function runSearchByFile(files: string[], opts: Options): Promise<void> {
    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const projectPath = /^\d+$/.test(api.project)
        ? (await getProject(api, api.project)).path_with_namespace
        : api.project;
    const { matches } = await searchMrsByFiles(api, { projectPath, files, log: progress });

    out.println(opts.json ? formatSearchJson(matches, files) : formatSearchText(matches, files));
}
