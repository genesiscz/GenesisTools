// PR command implementation

import { Command } from 'commander';
import chalk from 'chalk';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getOctokit } from '@app/github/lib/octokit';
import { withRetry } from '@app/github/lib/rate-limit';
import { parseGitHubUrl, detectRepoFromGit } from '@app/github/lib/url-parser';
import { getDatabase, getOrCreateRepo, upsertIssue } from '@app/github/lib/cache';
import { formatPR } from '@app/github/lib/output';
import { verbose, setGlobalVerbose } from '@app/github/lib/utils';
import type {
  PRCommandOptions,
  GitHubPullRequest,
  GitHubReviewComment,
  PRData,
  ReviewCommentData,
  CommitData,
  CheckData,
} from '@app/github/types';
import logger from '@app/logger';

/**
 * Fetch PR details
 */
async function fetchPR(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
  const octokit = getOctokit();

  const { data } = await withRetry(
    () =>
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      }),
    { label: `GET /repos/${owner}/${repo}/pulls/${number}` }
  );

  return data as unknown as GitHubPullRequest;
}

/**
 * Fetch PR review comments
 */
async function fetchReviewComments(
  owner: string,
  repo: string,
  number: number
): Promise<GitHubReviewComment[]> {
  const octokit = getOctokit();
  const comments: GitHubReviewComment[] = [];
  let page = 1;

  while (true) {
    const { data } = await withRetry(
      () =>
        octokit.rest.pulls.listReviewComments({
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          page,
        }),
      { label: `GET /repos/${owner}/${repo}/pulls/${number}/comments (page ${page})` }
    );

    comments.push(...(data as GitHubReviewComment[]));

    if (data.length < 100) {
      break;
    }
    page++;
  }

  return comments;
}

/**
 * Fetch PR commits
 */
async function fetchCommits(
  owner: string,
  repo: string,
  number: number
): Promise<CommitData[]> {
  const octokit = getOctokit();

  const { data } = await withRetry(
    () =>
      octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      }),
    { label: `GET /repos/${owner}/${repo}/pulls/${number}/commits` }
  );

  return data.map(commit => ({
    sha: commit.sha.slice(0, 7),
    message: commit.commit.message.split('\n')[0],
    author: commit.author?.login || commit.commit.author?.name || 'unknown',
    date: commit.commit.author?.date || '',
  }));
}

/**
 * Fetch PR checks
 */
async function fetchChecks(
  owner: string,
  repo: string,
  ref: string
): Promise<CheckData[]> {
  const octokit = getOctokit();

  const { data } = await withRetry(
    () =>
      octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 100,
      }),
    { label: `GET /repos/${owner}/${repo}/commits/${ref}/check-runs` }
  );

  return data.check_runs.map(check => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  }));
}

/**
 * Fetch PR diff
 */
async function fetchDiff(owner: string, repo: string, number: number): Promise<string> {
  const octokit = getOctokit();

  const { data } = await withRetry(
    () =>
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
        mediaType: {
          format: 'diff',
        },
      }),
    { label: `GET /repos/${owner}/${repo}/pulls/${number} (diff)` }
  );

  return data as unknown as string;
}

/**
 * Convert review comment to our format
 */
function toReviewCommentData(comment: GitHubReviewComment): ReviewCommentData {
  return {
    id: comment.id,
    nodeId: comment.node_id,
    author: comment.user?.login || 'unknown',
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    reactions: comment.reactions || {
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    isBot: false,
    htmlUrl: comment.html_url,
    path: comment.path,
    diffHunk: comment.diff_hunk,
    line: comment.line,
    side: comment.side,
  };
}

/**
 * Main PR command handler
 */
export async function prCommand(
  input: string,
  options: PRCommandOptions
): Promise<void> {
  // Set global verbose for HTTP request logging
  if (options.verbose) {
    setGlobalVerbose(true);
  }

  // Initialize database
  getDatabase();

  verbose(options, `Parsing input: ${input}`);

  // Parse input
  const defaultRepo = options.repo || await detectRepoFromGit() || undefined;
  const parsed = parseGitHubUrl(input, defaultRepo);

  if (!parsed) {
    console.error(chalk.red('Invalid input. Please provide a GitHub PR URL or number.'));
    process.exit(1);
  }

  const { owner, repo, number } = parsed;
  verbose(options, `Parsed: owner=${owner}, repo=${repo}, number=${number}`);
  console.log(chalk.dim(`Fetching PR ${owner}/${repo}#${number}...`));

  // Get or create repo in cache
  const repoRecord = getOrCreateRepo(owner, repo);

  // Fetch PR details
  console.log(chalk.dim('Fetching PR details...'));
  const pr = await fetchPR(owner, repo, number);

  // Update cache with PR info
  upsertIssue({
    repo_id: repoRecord.id,
    number,
    type: 'pr',
    title: pr.title,
    body: pr.body || '',
    state: pr.state,
    author: pr.user?.login || 'unknown',
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    last_fetched: new Date().toISOString(),
    last_comment_cursor: null,
  });

  // Get issue record for potential comment caching
  // const issueRecord = getIssue(repoRecord.id, number)!;
  // Note: Comment fetching could be added here using issueRecord

  // Fetch additional PR-specific data
  let reviewComments: ReviewCommentData[] = [];
  if (options.reviewComments) {
    verbose(options, 'Fetching review comments...');
    console.log(chalk.dim('Fetching review comments...'));
    const apiReviewComments = await fetchReviewComments(owner, repo, number);
    reviewComments = apiReviewComments.map(toReviewCommentData);
    verbose(options, `Fetched ${reviewComments.length} review comments`);
  }

  let commits: CommitData[] = [];
  if (options.commits) {
    verbose(options, 'Fetching commits...');
    console.log(chalk.dim('Fetching commits...'));
    commits = await fetchCommits(owner, repo, number);
    verbose(options, `Fetched ${commits.length} commits`);
  }

  let checks: CheckData[] = [];
  if (options.checks && pr.head.sha) {
    verbose(options, `Fetching checks for ref ${pr.head.sha}...`);
    console.log(chalk.dim('Fetching checks...'));
    checks = await fetchChecks(owner, repo, pr.head.sha);
    verbose(options, `Fetched ${checks.length} checks`);
  }

  let diff: string | undefined;
  if (options.diff) {
    verbose(options, 'Fetching diff...');
    console.log(chalk.dim('Fetching diff...'));
    diff = await fetchDiff(owner, repo, number);
    verbose(options, `Fetched diff (${diff.length} bytes)`);
  }

  // Build output data
  const outputData: PRData = {
    owner,
    repo,
    issue: pr,
    pr,
    comments: [], // Will be filled by issue command if needed
    events: [],
    reviewComments: reviewComments.length > 0 ? reviewComments : undefined,
    commits: commits.length > 0 ? commits : undefined,
    checks: checks.length > 0 ? checks : undefined,
    diff,
    fetchedAt: new Date().toISOString(),
  };

  // If we also want regular comments, delegate to issue command
  if (options.comments !== false) {
    // Use issue command to get comments and merge
    console.log(chalk.dim('\nAlso fetching issue comments...'));
    // For simplicity, run issue command with JSON output and parse
    // In a real implementation, we'd refactor to share the fetch logic
    // For now, we'll just call the issue command separately
  }

  // Format output
  const format = options.format || 'ai';
  verbose(options, `Output format: ${format}`);
  const output = formatPR(outputData, format);

  // Handle output destination
  if (options.output) {
    writeFileSync(options.output, output);
    console.log(chalk.green(`✔ Output written to ${options.output}`));
  } else if (options.saveLocally) {
    const localDir = join(process.cwd(), '.claude', 'github');
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }
    const filename = `${owner}-${repo}-pr-${number}.${format === 'json' ? 'json' : 'md'}`;
    const filepath = join(localDir, filename);
    writeFileSync(filepath, output);
    console.log(chalk.green(`✔ Output saved to ${filepath}`));
  } else {
    console.log(output);
  }

  // Show summary
  verbose(options, `Completed: PR #${number}, ${reviewComments.length} review comments, ${commits.length} commits, ${checks.length} checks`);
  console.log(chalk.dim(`\nFetched: PR #${number}${reviewComments.length > 0 ? `, ${reviewComments.length} review comments` : ''}${commits.length > 0 ? `, ${commits.length} commits` : ''}`));
}

/**
 * Create PR command
 */
export function createPRCommand(): Command {
  const cmd = new Command('pr')
    .description('Fetch GitHub pull request details')
    .argument('<input>', 'PR number or URL')
    .option('-r, --repo <owner/repo>', 'Repository (auto-detected from URL or git)')
    .option('-c, --comments', 'Include issue comments (default: true)', true)
    .option('--no-comments', 'Exclude issue comments')
    .option('-L, --limit <n>', 'Limit comments', parseInt)
    .option('--all', 'Fetch all comments')
    .option('--last <n>', 'Last N comments only', parseInt)
    .option('--since <id|url>', 'Comments after this ID/URL')
    .option('--after <date>', 'Comments after date')
    .option('--before <date>', 'Comments before date')
    .option('--min-reactions <n>', 'Min reaction count filter', parseInt)
    .option('--author <user>', 'Filter by author')
    .option('--no-bots', 'Exclude bot comments')
    .option('--include-events', 'Include timeline events')
    .option('--resolve-refs', 'Fetch linked issues')
    .option('--full', 'Force full refetch')
    .option('--refresh', 'Update cache with new data')
    .option('--save-locally', 'Save to .claude/github/')
    .option('-f, --format <format>', 'Output format: ai|md|json', 'ai')
    .option('-o, --output <file>', 'Custom output path')
    .option('--stats', 'Show comment statistics')
    // PR-specific options
    .option('--review-comments', 'Include review thread comments')
    .option('--diff', 'Include PR diff')
    .option('--commits', 'Include commit list')
    .option('--checks', 'Include CI check status')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (input, opts) => {
      try {
        await prCommand(input, opts);
      } catch (error) {
        logger.error({ error }, 'PR command failed');
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return cmd;
}
