// Releases command: a repository's releases as one markdown document

import { resolve } from "node:path";
import {
    collectReleases,
    parseRepoRef,
    type RawRelease,
    RELEASES_PER_PAGE,
    type ReleaseNote,
    renderReleasesMarkdown,
} from "@app/github/lib/releases";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { getOctokit } from "@genesiscz/utils/github/octokit";
import { withRetry } from "@genesiscz/utils/github/rate-limit";
import { parseDate } from "@genesiscz/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@genesiscz/utils/github/utils";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import { Command } from "commander";

export interface ReleasesCommandOptions {
    limit?: string;
    since?: string;
    /** Commander sets this to false for `--no-prereleases`. */
    prereleases: boolean;
    oldest?: boolean;
    json?: boolean;
    output?: string;
    clipboard?: boolean;
    verbose?: boolean;
}

function errorStatus(error: unknown): number | undefined {
    if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
        return error.status;
    }

    return undefined;
}

function describeFetchError(error: unknown, slug: string): string {
    const status = errorStatus(error);

    if (status === 404) {
        return `Repository ${slug} not found, or it is private and the token cannot see it.`;
    }

    if (status === 403 || status === 429) {
        return "GitHub rate limit reached. Set GITHUB_TOKEN or run `gh auth login` for a higher limit.";
    }

    return error instanceof Error ? error.message : String(error);
}

function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const limit = /^\d+$/.test(value) ? Number(value) : 0;

    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer, got "${value}"`);
    }

    return limit;
}

function parseSince(value: string | undefined): Date | undefined {
    if (value === undefined) {
        return undefined;
    }

    const since = parseDate(value);

    if (!since) {
        throw new Error(`--since must be an ISO date or a relative one such as 7d, 2w or 3m, got "${value}"`);
    }

    return since;
}

export async function releasesCommand(repoArg: string, options: ReleasesCommandOptions): Promise<void> {
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    const ref = parseRepoRef(repoArg);

    if (!ref) {
        throw new Error(`"${repoArg}" is not a repository. Use owner/repo or a github.com URL.`);
    }

    const { owner, repo } = ref;
    const limit = parseLimit(options.limit);
    const since = parseSince(options.since);
    const octokit = getOctokit();
    verbose(options, `Releases of ${owner}/${repo}: limit ${limit ?? "none"}, since ${since?.toISOString() ?? "any"}`);

    let releases: ReleaseNote[];

    try {
        releases = await collectReleases({
            limit,
            since,
            prereleases: options.prereleases,
            oldestFirst: options.oldest,
            listPage: async (page): Promise<RawRelease[]> => {
                const { data } = await withRetry(
                    () => octokit.rest.repos.listReleases({ owner, repo, per_page: RELEASES_PER_PAGE, page }),
                    { label: `GET /repos/${owner}/${repo}/releases?page=${page}` }
                );

                return data;
            },
        });
    } catch (error) {
        logger.debug({ error, owner, repo }, "release listing failed");
        throw new Error(describeFetchError(error, `${owner}/${repo}`));
    }

    logger.debug({ owner, repo, count: releases.length }, "releases collected");

    const content = options.json
        ? SafeJSON.stringify(releases, null, 2)
        : renderReleasesMarkdown({ owner, repo, releases, generatedAt: new Date() });

    if (!options.output && !options.clipboard) {
        out.println(content);
        return;
    }

    if (options.output) {
        const outputPath = resolve(options.output);
        await Bun.write(outputPath, content);
        out.log.success(`${releases.length} release(s) written to ${outputPath}`);
    }

    if (options.clipboard) {
        await copyToClipboard(content, { silent: true });
        out.log.success(`${releases.length} release(s) copied to clipboard`);
    }
}

export function createReleasesCommand(): Command {
    return new Command("releases")
        .description("Write a repository's releases as one markdown document")
        .argument("<repo>", "Repository: owner/repo or a github.com URL")
        .option("-L, --limit <n>", "Keep only the newest N releases")
        .option("--since <date>", "Only releases published since a date (ISO 8601, or relative: 7d, 2w, 3m)")
        .option("--no-prereleases", "Skip pre-releases (drafts are always skipped)")
        .option("--oldest", "List the oldest first instead of the newest first")
        .option("--json", "Emit the releases as JSON instead of markdown")
        .option("-o, --output <file>", "Write to a file instead of stdout")
        .option("-c, --clipboard", "Copy to the clipboard instead of stdout")
        .option("-v, --verbose", "Enable verbose logging")
        .addHelpText(
            "after",
            `
Examples:
  # The three newest releases of a repository, to stdout
  ${toolCommand("github releases")} oven-sh/bun --limit 3

  # Stable releases since the start of the year, into a file
  ${toolCommand("github releases")} facebook/react --since 2026-01-01 --no-prereleases -o react-releases.md

  # Last month of releases, copied for pasting into a changelog
  ${toolCommand("github releases")} https://github.com/vercel/next.js --since 1m --clipboard

  # Machine-readable
  ${toolCommand("github releases")} oven-sh/bun --limit 5 --json
`
        )
        .action(async (repo: string, opts: ReleasesCommandOptions) => {
            try {
                await releasesCommand(repo, opts);
            } catch (error) {
                out.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exitCode = 1;
            }
        });
}
