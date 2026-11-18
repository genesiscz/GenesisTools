// Search command implementation

import { rankedIssueBackends, searchKeywordIssues } from "@app/github/lib/issue-search";
import { formatRepoResults, formatSearchResults } from "@app/github/lib/output";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { batchFetchCommentReactions } from "@genesiscz/utils/github/graphql";
import { getOctokit } from "@genesiscz/utils/github/octokit";
import { withRetry } from "@genesiscz/utils/github/rate-limit";
import {
    ISSUE_SEARCH_TYPES,
    type IssueSearchType,
    type RepoSearchResult,
    type SearchCommandOptions,
    type SearchResult,
} from "@genesiscz/utils/github/types";
import { setGlobalVerbose, verbose } from "@genesiscz/utils/github/utils";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Search GitHub repositories using /search/repositories
 */
async function searchRepos(query: string, options: SearchCommandOptions): Promise<RepoSearchResult[]> {
    const octokit = getOctokit();
    let searchQuery = query;

    // Convenience options
    if (options.language) {
        searchQuery += ` language:${options.language}`;
    }
    if (options.minStars !== undefined) {
        searchQuery += ` stars:>=${options.minStars}`;
    }

    out.println(chalk.dim(`Searching repos: ${searchQuery}`));

    const { data } = await withRetry(
        () =>
            octokit.rest.search.repos({
                q: searchQuery,
                sort: options.sort as "stars" | "forks" | "help-wanted-issues" | "updated" | undefined,
                order: "desc",
                per_page: options.limit || 30,
            }),
        { label: `GET /search/repositories?q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
    );

    return data.items.map((item) => ({
        name: item.full_name,
        description: item.description ?? null,
        language: item.language ?? null,
        stars: item.stargazers_count,
        forks: item.forks_count,
        openIssues: item.open_issues_count,
        topics: item.topics ?? [],
        archived: item.archived ?? false,
        url: item.html_url,
        pushedAt: item.pushed_at ?? item.updated_at,
        createdAt: item.created_at,
        license: item.license?.spdx_id ?? null,
    }));
}

/**
 * Main search command handler
 */
export async function searchCommand(query: string, options: SearchCommandOptions): Promise<void> {
    // Set global verbose for HTTP request logging
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    verbose(options, `Search query: ${query}`);
    verbose(
        options,
        `Options: type=${options.type || "all"}, repo=${options.repo || "any"}, state=${options.state || "all"}`
    );

    if ((options.searchType || options.local) && options.type === "repo") {
        throw new Error("--search-type and --local apply to issues and pull requests. Omit them for --type repo.");
    }

    if (options.local && (!options.searchType || options.searchType === "keyword")) {
        throw new Error("--local requires --search-type semantic or --search-type hybrid.");
    }

    if (options.searchType && options.searchType !== "keyword") {
        const backend = rankedIssueBackends[options.local ? "local" : "github"];
        const results = await backend.search(query, { ...options, searchType: options.searchType });
        const format = options.format || "ai";
        const output =
            results.length || format === "json" ? formatSearchResults(results, format) : backend.emptyMessage;
        if (options.output) {
            await Bun.write(options.output, output);
            out.println(chalk.green(`✔ Output written to ${options.output}`));
        } else {
            out.println(output);
        }
        return;
    }

    // Repo search uses a completely different endpoint
    if (options.type === "repo") {
        const repos = await searchRepos(query, options);
        verbose(options, `Found ${repos.length} repositories`);
        if (repos.length === 0) {
            out.println(chalk.yellow("No repositories found."));
            return;
        }
        const format = options.format || "ai";
        const output = formatRepoResults(repos, format);
        if (options.output) {
            await Bun.write(options.output, output);
            out.println(chalk.green(`✔ Output written to ${options.output}`));
        } else {
            out.println(output);
        }
        verbose(options, `Completed: ${repos.length} repos displayed`);
        return;
    }

    const { results: hits, merge } = await searchKeywordIssues(query, options);
    let results = hits;
    let footer = "";

    if (merge) {
        const parts = [`Advanced: ${merge.advancedCount}, Legacy: ${merge.legacyCount}, Combined: ${results.length}`];
        if (merge.duplicates.length > 0) {
            const dedupIds = merge.duplicates.map((d) => `#${d.number}`).join(", ");
            parts.push(`Deduplicated (${merge.duplicates.length}): ${dedupIds}`);
        }
        footer = parts.join("\n");
    }

    verbose(options, `Found ${results.length} results`);

    // Client-side safety filter for issue-level reactions
    if (options.minReactions !== undefined) {
        const min = options.minReactions;
        results = results.filter((r) => r.reactions !== null && r.reactions >= min);
    }

    // GraphQL-based comment reaction filter
    let preFilterResults: SearchResult[] | undefined;
    if (options.minCommentReactions !== undefined && results.length > 0) {
        const minCommentReactions = options.minCommentReactions;
        // Estimate cost using actual comment counts from search results (capped at 100 since GraphQL fetches first:100)
        const totalComments = results.reduce((sum, r) => sum + Math.min(r.comments ?? 0, 100), 0);
        const estimatedCost = results.length * 2 + totalComments; // 2 per issue (node + connection) + 1 per comment node
        const issueList = results.map((r) => `#${r.number} (${r.comments} comments)`).join(", ");

        out.println("");
        out.println(
            chalk.yellow(
                `⚠ GraphQL comment scan: ${results.length} issues, ${totalComments} comments (~${estimatedCost} of 5,000/hr points)`
            )
        );
        out.println(chalk.dim(`  ${issueList}`));
        out.println(chalk.dim(`  Tip: To check specific issues instead:`));
        out.println(
            chalk.cyan(
                `    ${toolCommand("github issue")} <number>,<number> --repo ${results[0]?.repo || "owner/repo"} --min-comment-reactions ${options.minCommentReactions}`
            )
        );
        out.println("");

        preFilterResults = [...results];

        // Group results by repo
        const byRepo = new Map<string, SearchResult[]>();
        for (const r of results) {
            const existing = byRepo.get(r.repo) || [];
            existing.push(r);
            byRepo.set(r.repo, existing);
        }

        // Batch-fetch comment reactions per repo
        const keep = new Set<string>();
        for (const [repoFullName, repoResults] of byRepo) {
            const [repoOwner, repoName] = repoFullName.split("/");
            const numbers = repoResults.map((r) => r.number);
            const reactions = await batchFetchCommentReactions(repoOwner, repoName, numbers);

            for (const [num, info] of reactions) {
                if (info.maxCommentReactions >= minCommentReactions) {
                    keep.add(`${repoFullName}#${num}`);
                }
            }
        }

        results = results.filter((r) => keep.has(`${r.repo}#${r.number}`));
        out.println(
            chalk.dim(
                `Filtered to ${results.length} of ${preFilterResults.length} results with comment reactions >= ${options.minCommentReactions}`
            )
        );
    }

    if (results.length === 0) {
        // If comment-reaction filter eliminated everything, still show the original search results
        if (preFilterResults && preFilterResults.length > 0) {
            out.println(
                chalk.yellow(
                    `\nNo issues matched --min-comment-reactions ${options.minCommentReactions}. Showing all ${preFilterResults.length} search results:\n`
                )
            );
            results = preFilterResults;
        } else {
            out.println(chalk.yellow("No results found."));
            return;
        }
    }

    // Format output
    const format = options.format || "ai";
    verbose(options, `Output format: ${format}`);
    const output = formatSearchResults(results, format);

    if (options.output) {
        await Bun.write(options.output, output);
        out.println(chalk.green(`✔ Output written to ${options.output}`));
    } else {
        out.println(output);
    }

    if (footer) {
        out.println(chalk.dim(`\n${footer}`));
    }

    verbose(options, `Completed: ${results.length} results displayed`);
}

/**
 * Create search command
 */
export function createSearchCommand(): Command {
    const cmd = new Command("search")
        .description("Search GitHub issues and PRs")
        .argument("<query>", "Search query")
        .option("--search-type [mode]", "Rank issues and PRs on GitHub: keyword (default), semantic or hybrid")
        .option("--local", "Run semantic or hybrid search offline on the local GitHub cache")
        .option("--type <type>", "Filter: issue|pr|all|repo", "all")
        .option("-r, --repo <owner/repo>", "Limit to repository")
        .option("--state <state>", "Filter: open|closed|all", "all")
        .option(
            "--sort <field>",
            "Sort: created|updated|comments|reactions (issues/PRs); stars|forks|updated|help-wanted-issues (repos)"
        )
        .option("-L, --limit <n>", "Max results", (value) => Number.parseInt(value, 10), 30)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("--advanced", "Use only the advanced keyword search backend")
        .option("--legacy", "Use only the legacy keyword search backend")
        .option("--min-reactions <n>", "Min reaction count on issue/PR", parseInt)
        .option("--min-comment-reactions <n>", "Min reactions on any comment (uses GraphQL, slower)", parseInt)
        .option("--language <lang>", "Filter repos by language (shorthand for language:<lang>)")
        .option("--min-stars <n>", "Minimum stars for repo search (shorthand for stars:>=N)", parseInt)
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (query, opts) => {
            try {
                const searchType = await pickEnumFlag({
                    tool: "tools github search",
                    subcommand: ["search"],
                    flag: "--search-type",
                    given: opts.searchType,
                    values: ISSUE_SEARCH_TYPES,
                    fallback: "keyword",
                    accepts: (value): value is IssueSearchType => ISSUE_SEARCH_TYPES.some((mode) => mode === value),
                });
                if (searchType === null) {
                    return;
                }

                await searchCommand(query, {
                    ...opts,
                    searchType: opts.searchType === undefined ? undefined : searchType,
                });
            } catch (error) {
                logger.error({ error }, "Search command failed");

                // Provide helpful tips on common errors
                const errorMessage = error instanceof Error ? error.message : String(error);

                if (errorMessage.includes("is:issue") || errorMessage.includes("is:pull-request")) {
                    out.error(chalk.yellow("\n📝 GitHub Search Syntax Tips:"));
                    out.error(chalk.dim(`  • For issues: ${toolCommand("github search")} "query" --type issue`));
                    out.error(chalk.dim(`  • For PRs: ${toolCommand("github search")} "query" --type pr`));
                    out.error(chalk.dim(`  • For code: ${toolCommand("github code")} "query" --repo owner/repo`));
                    out.error(chalk.dim("  • Add repo filter: --repo owner/repo"));
                    out.error(chalk.dim("  • Filter by state: --state open|closed"));
                    out.error("");
                }

                out.error(chalk.red(`Error: ${errorMessage}`));
                process.exitCode = 1;
            }
        });

    return cmd;
}
