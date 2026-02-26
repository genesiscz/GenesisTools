// Search command implementation

import { formatRepoResults, formatSearchResults } from "@app/github/lib/output";
import type { RepoSearchResult, SearchCommandOptions, SearchResult } from "@app/github/types";
import logger from "@app/logger";
import { batchFetchCommentReactions } from "@app/utils/github/graphql";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { parseRepo } from "@app/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

interface GitHubSearchItem {
    number: number;
    title: string;
    state: string;
    user: { login: string } | null;
    created_at: string;
    updated_at: string;
    comments: number;
    reactions?: { total_count: number };
    repository_url: string;
    html_url: string;
    pull_request?: { url: string | null };
}

/**
 * Extract repo name from repository_url
 */
function extractRepoFromUrl(url: string): string {
    const match = url.match(/repos\/([^/]+\/[^/]+)$/);
    return match ? match[1] : "unknown/unknown";
}

/**
 * Build base query with repo and state filters (shared by both backends)
 */
function buildBaseQuery(query: string, options: SearchCommandOptions): string {
    let searchQuery = query;

    if (options.repo) {
        const parsed = parseRepo(options.repo);
        if (parsed) {
            searchQuery += ` repo:${parsed.owner}/${parsed.repo}`;
        }
    }

    if (options.state === "open") {
        searchQuery += " is:open";
    } else if (options.state === "closed") {
        searchQuery += " is:closed";
    }

    if (options.minReactions !== undefined) {
        searchQuery += ` reactions:>=${options.minReactions}`;
    }

    if (options.minStars !== undefined) {
        searchQuery += ` stars:>=${options.minStars}`;
    }

    return searchQuery;
}

/**
 * Map API response items to SearchResult
 */
function mapItems(items: GitHubSearchItem[], source: "advanced" | "legacy"): SearchResult[] {
    return items.map((item) => ({
        type: item.pull_request ? ("pr" as const) : ("issue" as const),
        number: item.number,
        title: item.title,
        state: item.state,
        author: item.user?.login || "unknown",
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        comments: item.comments,
        reactions: item.reactions?.total_count || 0,
        repo: extractRepoFromUrl(item.repository_url),
        url: item.html_url,
        source,
    }));
}

/**
 * Search using legacy backend (current behavior)
 */
async function searchLegacy(query: string, options: SearchCommandOptions): Promise<SearchResult[]> {
    const octokit = getOctokit();
    let searchQuery = buildBaseQuery(query, options);

    // Legacy uses is: for type filtering
    if (options.type === "issue") {
        searchQuery += " is:issue";
    } else if (options.type === "pr") {
        searchQuery += " is:pr";
    } else {
        searchQuery += " is:issue is:pr";
    }

    console.log(chalk.dim(`Searching (legacy): ${searchQuery}`));

    const { data } = await withRetry(
        () =>
            octokit.rest.search.issuesAndPullRequests({
                q: searchQuery,
                sort: options.sort as "comments" | "reactions" | "interactions" | "created" | "updated" | undefined,
                order: "desc",
                per_page: options.limit || 30,
            }),
        { label: `GET /search/issues?q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
    );

    return mapItems(data.items as GitHubSearchItem[], "legacy");
}

/**
 * Search using advanced backend (advanced_search=true, type: qualifiers)
 * See: gh CLI PR #11638
 */
async function searchAdvanced(query: string, options: SearchCommandOptions): Promise<SearchResult[]> {
    const octokit = getOctokit();
    let searchQuery = buildBaseQuery(query, options);

    // Advanced uses type: instead of is: for issue/pr filtering
    if (options.type === "issue") {
        searchQuery += " type:issue";
    } else if (options.type === "pr") {
        searchQuery += " type:pr";
    } else {
        searchQuery += " type:issue type:pr";
    }

    console.log(chalk.dim(`Searching (advanced): ${searchQuery}`));

    const { data } = await withRetry(
        () =>
            octokit.request("GET /search/issues", {
                q: searchQuery,
                sort: (options.sort || undefined) as
                    | "comments"
                    | "reactions"
                    | "interactions"
                    | "created"
                    | "updated"
                    | undefined,
                order: "desc" as const,
                per_page: options.limit || 30,
                advanced_search: "true",
            }),
        { label: `GET /search/issues?advanced_search=true&q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
    );

    return mapItems(data.items as GitHubSearchItem[], "advanced");
}

interface MergeResult {
    results: SearchResult[];
    duplicates: Array<{ repo: string; number: number }>;
    advancedCount: number;
    legacyCount: number;
}

/**
 * Merge results from both backends and deduplicate by repo#number.
 * Advanced results take priority in ordering.
 */
function mergeAndDeduplicate(advancedResults: SearchResult[], legacyResults: SearchResult[]): MergeResult {
    const seen = new Map<string, SearchResult>();
    const duplicates: Array<{ repo: string; number: number }> = [];

    // Advanced results first (newer backend, potentially better ranking)
    for (const r of advancedResults) {
        const key = `${r.repo}#${r.number}`;
        seen.set(key, { ...r, source: "advanced" });
    }

    for (const r of legacyResults) {
        const key = `${r.repo}#${r.number}`;
        const existing = seen.get(key);
        if (existing) {
            existing.source = "both";
            duplicates.push({ repo: r.repo, number: r.number });
        } else {
            seen.set(key, { ...r, source: "legacy" });
        }
    }

    return {
        results: [...seen.values()],
        duplicates,
        advancedCount: advancedResults.length,
        legacyCount: legacyResults.length,
    };
}

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

    console.log(chalk.dim(`Searching repos: ${searchQuery}`));

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

    // Repo search uses a completely different endpoint
    if (options.type === "repo") {
        const repos = await searchRepos(query, options);
        verbose(options, `Found ${repos.length} repositories`);
        if (repos.length === 0) {
            console.log(chalk.yellow("No repositories found."));
            return;
        }
        const format = options.format || "ai";
        const output = formatRepoResults(repos, format);
        if (options.output) {
            await Bun.write(options.output, output);
            console.log(chalk.green(`✔ Output written to ${options.output}`));
        } else {
            console.log(output);
        }
        verbose(options, `Completed: ${repos.length} repos displayed`);
        return;
    }

    // Determine which backends to run
    const runAdvanced = options.advanced || (!options.advanced && !options.legacy);
    const runLegacy = options.legacy || (!options.advanced && !options.legacy);

    let results: SearchResult[];
    let footer = "";

    if (runAdvanced && runLegacy) {
        // Run BOTH in parallel, then merge & deduplicate
        const [advancedResults, legacyResults] = await Promise.all([
            searchAdvanced(query, options),
            searchLegacy(query, options),
        ]);
        const merged = mergeAndDeduplicate(advancedResults, legacyResults);
        results = merged.results;

        const parts: string[] = [];
        parts.push(`Advanced: ${merged.advancedCount}, Legacy: ${merged.legacyCount}, Combined: ${results.length}`);
        if (merged.duplicates.length > 0) {
            const dedupIds = merged.duplicates.map((d) => `#${d.number}`).join(", ");
            parts.push(`Deduplicated (${merged.duplicates.length}): ${dedupIds}`);
        }
        footer = parts.join("\n");
    } else if (runAdvanced) {
        results = await searchAdvanced(query, options);
    } else {
        results = await searchLegacy(query, options);
    }

    verbose(options, `Found ${results.length} results`);

    // Client-side safety filter for issue-level reactions
    if (options.minReactions !== undefined) {
        const min = options.minReactions;
        results = results.filter((r) => r.reactions >= min);
    }

    // GraphQL-based comment reaction filter
    let preFilterResults: SearchResult[] | undefined;
    if (options.minCommentReactions !== undefined && results.length > 0) {
        const minCommentReactions = options.minCommentReactions;
        // Estimate cost using actual comment counts from search results (capped at 100 since GraphQL fetches first:100)
        const totalComments = results.reduce((sum, r) => sum + Math.min(r.comments, 100), 0);
        const estimatedCost = results.length * 2 + totalComments; // 2 per issue (node + connection) + 1 per comment node
        const issueList = results.map((r) => `#${r.number} (${r.comments} comments)`).join(", ");

        console.log("");
        console.log(
            chalk.yellow(
                `⚠ GraphQL comment scan: ${results.length} issues, ${totalComments} comments (~${estimatedCost} of 5,000/hr points)`
            )
        );
        console.log(chalk.dim(`  ${issueList}`));
        console.log(chalk.dim(`  Tip: To check specific issues instead:`));
        console.log(
            chalk.cyan(
                `    tools github issue <number>,<number> --repo ${results[0]?.repo || "owner/repo"} --min-comment-reactions ${options.minCommentReactions}`
            )
        );
        console.log("");

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
        console.log(
            chalk.dim(
                `Filtered to ${results.length} of ${preFilterResults.length} results with comment reactions >= ${options.minCommentReactions}`
            )
        );
    }

    if (results.length === 0) {
        // If comment-reaction filter eliminated everything, still show the original search results
        if (preFilterResults && preFilterResults.length > 0) {
            console.log(
                chalk.yellow(
                    `\nNo issues matched --min-comment-reactions ${options.minCommentReactions}. Showing all ${preFilterResults.length} search results:\n`
                )
            );
            results = preFilterResults;
        } else {
            console.log(chalk.yellow("No results found."));
            return;
        }
    }

    // Format output
    const format = options.format || "ai";
    verbose(options, `Output format: ${format}`);
    const output = formatSearchResults(results, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`✔ Output written to ${options.output}`));
    } else {
        console.log(output);
    }

    if (footer) {
        console.log(chalk.dim(`\n${footer}`));
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
        .option("--type <type>", "Filter: issue|pr|all|repo", "all")
        .option("-r, --repo <owner/repo>", "Limit to repository")
        .option("--state <state>", "Filter: open|closed|all", "all")
        .option(
            "--sort <field>",
            "Sort: created|updated|comments|reactions (issues/PRs); stars|forks|updated|help-wanted-issues (repos)"
        )
        .option("-L, --limit <n>", "Max results", parseInt, 30)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("--advanced", "Use only advanced search backend")
        .option("--legacy", "Use only legacy search backend")
        .option("--min-reactions <n>", "Min reaction count on issue/PR", parseInt)
        .option("--min-comment-reactions <n>", "Min reactions on any comment (uses GraphQL, slower)", parseInt)
        .option("--language <lang>", "Filter repos by language (shorthand for language:<lang>)")
        .option("--min-stars <n>", "Minimum stars for repo search (shorthand for stars:>=N)", parseInt)
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (query, opts) => {
            try {
                await searchCommand(query, opts);
            } catch (error) {
                logger.error({ error }, "Search command failed");

                // Provide helpful tips on common errors
                const errorMessage = error instanceof Error ? error.message : String(error);

                if (errorMessage.includes("is:issue") || errorMessage.includes("is:pull-request")) {
                    console.error(chalk.yellow("\n📝 GitHub Search Syntax Tips:"));
                    console.error(chalk.dim('  • For issues: tools github search "query" --type issue'));
                    console.error(chalk.dim('  • For PRs: tools github search "query" --type pr'));
                    console.error(chalk.dim('  • For code: tools github code "query" --repo owner/repo'));
                    console.error(chalk.dim("  • Add repo filter: --repo owner/repo"));
                    console.error(chalk.dim("  • Filter by state: --state open|closed"));
                    console.error("");
                }

                console.error(chalk.red(`Error: ${errorMessage}`));
                process.exit(1);
            }
        });

    return cmd;
}
