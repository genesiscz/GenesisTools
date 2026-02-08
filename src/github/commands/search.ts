// Search command implementation

import { Command } from 'commander';
import chalk from 'chalk';
import { getOctokit } from '@app/github/lib/octokit';
import { withRetry } from '@app/github/lib/rate-limit';
import { parseRepo } from '@app/github/lib/url-parser';
import { formatSearchResults } from '@app/github/lib/output';
import { verbose, setGlobalVerbose } from '@app/github/lib/utils';
import type { SearchCommandOptions, SearchResult } from '@app/github/types';
import logger from '@app/logger';

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
  return match ? match[1] : 'unknown/unknown';
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

  if (options.state === 'open') {
    searchQuery += ' is:open';
  } else if (options.state === 'closed') {
    searchQuery += ' is:closed';
  }

  return searchQuery;
}

/**
 * Map API response items to SearchResult
 */
function mapItems(items: GitHubSearchItem[], source: 'advanced' | 'legacy'): SearchResult[] {
  return items.map((item) => ({
    type: item.pull_request ? 'pr' as const : 'issue' as const,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.user?.login || 'unknown',
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
async function searchLegacy(
  query: string,
  options: SearchCommandOptions
): Promise<SearchResult[]> {
  const octokit = getOctokit();
  let searchQuery = buildBaseQuery(query, options);

  // Legacy uses is: for type filtering
  if (options.type === 'issue') {
    searchQuery += ' is:issue';
  } else if (options.type === 'pr') {
    searchQuery += ' is:pr';
  } else {
    searchQuery += ' is:issue is:pr';
  }

  console.log(chalk.dim(`Searching (legacy): ${searchQuery}`));

  const { data } = await withRetry(
    () =>
      octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        sort: options.sort as 'comments' | 'reactions' | 'interactions' | 'created' | 'updated' | undefined,
        order: 'desc',
        per_page: options.limit || 30,
      }),
    { label: `GET /search/issues?q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
  );

  return mapItems(data.items as GitHubSearchItem[], 'legacy');
}

/**
 * Search using advanced backend (advanced_search=true, type: qualifiers)
 * See: gh CLI PR #11638
 */
async function searchAdvanced(
  query: string,
  options: SearchCommandOptions
): Promise<SearchResult[]> {
  const octokit = getOctokit();
  let searchQuery = buildBaseQuery(query, options);

  // Advanced uses type: instead of is: for issue/pr filtering
  if (options.type === 'issue') {
    searchQuery += ' type:issue';
  } else if (options.type === 'pr') {
    searchQuery += ' type:pr';
  } else {
    searchQuery += ' type:issue type:pr';
  }

  console.log(chalk.dim(`Searching (advanced): ${searchQuery}`));

  const { data } = await withRetry(
    () =>
      octokit.request('GET /search/issues', {
        q: searchQuery,
        sort: (options.sort || undefined) as 'comments' | 'reactions' | 'interactions' | 'created' | 'updated' | undefined,
        order: 'desc' as const,
        per_page: options.limit || 30,
        advanced_search: 'true',
      }),
    { label: `GET /search/issues?advanced_search=true&q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
  );

  return mapItems(data.items as GitHubSearchItem[], 'advanced');
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
function mergeAndDeduplicate(
  advancedResults: SearchResult[],
  legacyResults: SearchResult[],
): MergeResult {
  const seen = new Map<string, SearchResult>();
  const duplicates: Array<{ repo: string; number: number }> = [];

  // Advanced results first (newer backend, potentially better ranking)
  for (const r of advancedResults) {
    const key = `${r.repo}#${r.number}`;
    seen.set(key, { ...r, source: 'advanced' });
  }

  for (const r of legacyResults) {
    const key = `${r.repo}#${r.number}`;
    const existing = seen.get(key);
    if (existing) {
      existing.source = 'both';
      duplicates.push({ repo: r.repo, number: r.number });
    } else {
      seen.set(key, { ...r, source: 'legacy' });
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
 * Main search command handler
 */
export async function searchCommand(
  query: string,
  options: SearchCommandOptions
): Promise<void> {
  // Set global verbose for HTTP request logging
  if (options.verbose) {
    setGlobalVerbose(true);
  }

  verbose(options, `Search query: ${query}`);
  verbose(options, `Options: type=${options.type || 'all'}, repo=${options.repo || 'any'}, state=${options.state || 'all'}`);

  // Determine which backends to run
  const runAdvanced = options.advanced || (!options.advanced && !options.legacy);
  const runLegacy = options.legacy || (!options.advanced && !options.legacy);

  let results: SearchResult[];
  let footer = '';

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
      const dedupIds = merged.duplicates.map(d => `#${d.number}`).join(', ');
      parts.push(`Deduplicated (${merged.duplicates.length}): ${dedupIds}`);
    }
    footer = parts.join('\n');
  } else if (runAdvanced) {
    results = await searchAdvanced(query, options);
  } else {
    results = await searchLegacy(query, options);
  }

  verbose(options, `Found ${results.length} results`);

  if (results.length === 0) {
    console.log(chalk.yellow('No results found.'));
    return;
  }

  // Format output
  const format = options.format || 'ai';
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
  const cmd = new Command('search')
    .description('Search GitHub issues and PRs')
    .argument('<query>', 'Search query')
    .option('--type <type>', 'Filter: issue|pr|all', 'all')
    .option('-r, --repo <owner/repo>', 'Limit to repository')
    .option('--state <state>', 'Filter: open|closed|all', 'all')
    .option('--sort <field>', 'Sort: created|updated|comments|reactions')
    .option('-L, --limit <n>', 'Max results', parseInt, 30)
    .option('-f, --format <format>', 'Output format: ai|md|json', 'ai')
    .option('--advanced', 'Use only advanced search backend')
    .option('--legacy', 'Use only legacy search backend')
    .option('-o, --output <file>', 'Output path')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (query, opts) => {
      try {
        await searchCommand(query, opts);
      } catch (error) {
        logger.error({ error }, 'Search command failed');

        // Provide helpful tips on common errors
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('is:issue') || errorMessage.includes('is:pull-request')) {
          console.error(chalk.yellow('\n📝 GitHub Search Syntax Tips:'));
          console.error(chalk.dim('  • For issues: tools github search "query" --type issue'));
          console.error(chalk.dim('  • For PRs: tools github search "query" --type pr'));
          console.error(chalk.dim('  • For code: tools github code "query" --repo owner/repo'));
          console.error(chalk.dim('  • Add repo filter: --repo owner/repo'));
          console.error(chalk.dim('  • Filter by state: --state open|closed'));
          console.error('');
        }

        console.error(chalk.red(`Error: ${errorMessage}`));
        process.exit(1);
      }
    });

  return cmd;
}
