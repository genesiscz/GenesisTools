/**
 * Open MRs that touch specific files, through GitLab GraphQL.
 *
 *   tools gitlab search-by-file --file bun.lock
 *   tools gitlab search-by-file --file bun.lock --file package.json --json
 *
 * Progress goes to stderr, results to stdout.
 */

import { collect, progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { getProject, resolveProjectApi } from "@app/gitlab/lib/client";
import { formatSearchJson, formatSearchText, searchMrsByFiles } from "@app/gitlab/lib/search-by-file";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Options extends TargetOptions {
    file: string[];
    json?: boolean;
}

export function registerSearchByFile(parent: Command): Command {
    return withProject(
        parent
            .command("search-by-file")
            .description("Find open MRs that touch specific files using GitLab GraphQL")
            .requiredOption("--file <path>", "File path to match, exact or as a path suffix (repeatable)", collect, [])
            .option("--json", "Emit JSON instead of human-readable text")
    ).action(runSearchByFile);
}

async function runSearchByFile(opts: Options): Promise<void> {
    const files = opts.file;
    if (!files.length) {
        throw new Error('Usage: tools gitlab search-by-file --file "bun.lock" [--json]');
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const projectPath = /^\d+$/.test(api.project)
        ? (await getProject(api, api.project)).path_with_namespace
        : api.project;
    const { matches } = await searchMrsByFiles(api, { projectPath, files, log: progress });

    out.println(opts.json ? formatSearchJson(matches, files) : formatSearchText(matches, files));
}
