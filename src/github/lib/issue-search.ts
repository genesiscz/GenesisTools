import { getOctokit, getSingleRequestOctokit } from "@genesiscz/utils/github/octokit";
import { isRateLimitError, withRetry } from "@genesiscz/utils/github/rate-limit";
import type { RankedIssueSearchType, SearchCommandOptions, SearchResult } from "@genesiscz/utils/github/types";
import { parseRepo } from "@genesiscz/utils/github/url-parser";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import { RequestError } from "octokit";

interface IssueSearchBackend<Options extends SearchCommandOptions = SearchCommandOptions> {
    search(query: string, options: Options): Promise<SearchResult[]>;
}

type RankedSearchOptions = SearchCommandOptions & { searchType: RankedIssueSearchType };

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

function issueQualifiers(options: SearchCommandOptions): string[] {
    const qualifiers: string[] = [];

    if (options.repo) {
        const parsed = parseRepo(options.repo);
        if (parsed) {
            qualifiers.push(`repo:${parsed.owner}/${parsed.repo}`);
        }
    }

    if (options.state === "open") {
        qualifiers.push("is:open");
    } else if (options.state === "closed") {
        qualifiers.push("is:closed");
    }

    if (options.minReactions !== undefined) {
        qualifiers.push(`reactions:>=${options.minReactions}`);
    }

    if (options.minStars !== undefined) {
        qualifiers.push(`stars:>=${options.minStars}`);
    }

    return qualifiers;
}

/**
 * Map API response items to SearchResult
 */
function mapItems(items: GitHubSearchItem[], source: "advanced" | "legacy" | RankedIssueSearchType): SearchResult[] {
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
    let searchQuery = [query, ...issueQualifiers(options)].join(" ");

    // Legacy uses is: for type filtering
    if (options.type === "issue") {
        searchQuery += " is:issue";
    } else if (options.type === "pr") {
        searchQuery += " is:pr";
    } else {
        searchQuery += " is:issue is:pr";
    }

    out.println(chalk.dim(`Searching (legacy): ${searchQuery}`));

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

    return mapItems(data.items, "legacy");
}

/**
 * Search using advanced backend (advanced_search=true, type: qualifiers)
 * See: gh CLI PR #11638
 */
async function searchAdvanced(query: string, options: SearchCommandOptions): Promise<SearchResult[]> {
    const octokit = getOctokit();
    let searchQuery = [query, ...issueQualifiers(options)].join(" ");

    // Advanced uses type: instead of is: for issue/pr filtering
    if (options.type === "issue") {
        searchQuery += " type:issue";
    } else if (options.type === "pr") {
        searchQuery += " type:pr";
    } else {
        searchQuery += " type:issue type:pr";
    }

    out.println(chalk.dim(`Searching (advanced): ${searchQuery}`));

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

    return mapItems(data.items, "advanced");
}

interface KeywordSearchResult {
    results: SearchResult[];
    merge?: {
        duplicates: Array<{ repo: string; number: number }>;
        advancedCount: number;
        legacyCount: number;
    };
}

/**
 * Merge results from both backends and deduplicate by repo#number.
 * Advanced results take priority in ordering.
 */
function mergeAndDeduplicate(advancedResults: SearchResult[], legacyResults: SearchResult[]): KeywordSearchResult {
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
        merge: { duplicates, advancedCount: advancedResults.length, legacyCount: legacyResults.length },
    };
}

const keywordIssueBackends: Record<"legacy" | "advanced", IssueSearchBackend> = {
    legacy: { search: searchLegacy },
    advanced: { search: searchAdvanced },
};

export async function searchKeywordIssues(query: string, options: SearchCommandOptions): Promise<KeywordSearchResult> {
    // Both flags, or neither, request the merged keyword results.
    if (Boolean(options.advanced) === Boolean(options.legacy)) {
        const [advanced, legacy] = await Promise.all([
            keywordIssueBackends.advanced.search(query, options),
            keywordIssueBackends.legacy.search(query, options),
        ]);
        return mergeAndDeduplicate(advanced, legacy);
    }

    const backend = keywordIssueBackends[options.advanced ? "advanced" : "legacy"];
    return { results: await backend.search(query, options) };
}

async function searchHostedIssues(query: string, options: RankedSearchOptions): Promise<SearchResult[]> {
    if (options.minCommentReactions !== undefined) {
        throw new Error(
            "--min-comment-reactions needs a comment scan. Use keyword search or --local for cached comments."
        );
    }

    if (options.sort || options.legacy || options.advanced || options.language || options.minStars !== undefined) {
        throw new Error(
            "Hosted semantic and hybrid search rank issues and PRs by relevance. Use keyword search for --sort, --legacy, --advanced, --language or --min-stars."
        );
    }

    if (options.repo && !parseRepo(options.repo)) {
        throw new Error(`Invalid repository "${options.repo}". Use owner/repo.`);
    }

    if (options.type && options.type !== "all" && options.type !== "issue" && options.type !== "pr") {
        throw new Error("Semantic and hybrid search support issues and pull requests. Choose --type issue, pr or all.");
    }

    if (options.state && options.state !== "all" && options.state !== "open" && options.state !== "closed") {
        throw new Error("Choose --state open, closed or all.");
    }

    const limit = options.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Hosted search --limit must be between 1 and 100 (one page).");
    }

    const qualifiers = issueQualifiers(options);
    if (options.type && options.type !== "all") {
        qualifiers.push(`is:${options.type}`);
    }

    const q = [...qualifiers, query].join(" ");
    const mode = options.searchType;
    logger.debug({ mode, limit }, "GET /search/issues with advanced_search=true");

    try {
        const { data } = await getSingleRequestOctokit().request("GET /search/issues", {
            q,
            per_page: limit,
            advanced_search: "true",
            search_type: mode,
        });
        return mapItems(data.items, mode);
    } catch (error) {
        if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 429)) {
            throw error;
        }

        const { response, status, message: detail } = error;
        const reset = response?.headers["x-ratelimit-reset"];
        const resetDate = new Date(Number(reset) * 1000);
        const resetTime = reset && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : undefined;
        const reason = isRateLimitError(error) ? "rate limit reached" : detail;
        const resetHint = resetTime ? `Rate limit resets at ${resetTime}.` : "GitHub did not provide a reset time.";
        const message = `GitHub ${mode} search (HTTP ${status}): ${reason}. Search quota: 10 requests per minute. ${resetHint}`;
        logger.warn({ mode, status, resetTime }, message);
        throw new Error(message, { cause: error });
    }
}

export const rankedIssueBackends: Record<
    "github" | "local",
    IssueSearchBackend<RankedSearchOptions> & { emptyMessage: string }
> = {
    github: {
        search: searchHostedIssues,
        emptyMessage: "No matching issues or pull requests on GitHub.",
    },
    local: {
        async search(query, options) {
            const { searchCachedIssues } = await import("./local-issue-search");
            return searchCachedIssues(query, options.searchType, options);
        },
        emptyMessage: "No matching issues or pull requests in the local GitHub cache.",
    },
};
