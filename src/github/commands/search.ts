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
 * Search issues and PRs
 */
async function searchGitHub(
  query: string,
  options: SearchCommandOptions
): Promise<SearchResult[]> {
  const octokit = getOctokit();

  // Build search query
  let searchQuery = query;

  // Add repo filter
  if (options.repo) {
    const parsed = parseRepo(options.repo);
    if (parsed) {
      searchQuery += ` repo:${parsed.owner}/${parsed.repo}`;
    }
  }

  // Add type filter
  if (options.type === 'issue') {
    searchQuery += ' is:issue';
  } else if (options.type === 'pr') {
    searchQuery += ' is:pr';
  }

  // Add state filter
  if (options.state === 'open') {
    searchQuery += ' is:open';
  } else if (options.state === 'closed') {
    searchQuery += ' is:closed';
  }

  console.log(chalk.dim(`Searching: ${searchQuery}`));

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

  return data.items.map((item: GitHubSearchItem) => ({
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
  }));
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

  const results = await searchGitHub(query, options);
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
    .option('-o, --output <file>', 'Output path')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (query, opts) => {
      try {
        await searchCommand(query, opts);
      } catch (error) {
        logger.error({ error }, 'Search command failed');
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return cmd;
}
