// Issue command implementation

import { Command } from 'commander';
import chalk from 'chalk';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getOctokit } from '@app/github/lib/octokit';
import { withRetry } from '@app/github/lib/rate-limit';
import { parseGitHubUrl, extractCommentId, parseDate, detectRepoFromGit } from '@app/github/lib/url-parser';
import {
  getDatabase,
  getOrCreateRepo,
  getIssue,
  upsertIssue,
  getComments as getCachedComments,
  getLastNComments,
  upsertComments,
  getCommentCount,
  upsertTimelineEvents,
  getFetchMetadata,
  updateFetchMetadata,
} from '@app/github/lib/cache';
import { processQuotes, findReplyTarget, detectCrossReferences } from '@app/github/lib/quotes';
import { formatIssue, calculateStats } from '@app/github/lib/output';
import { verbose, toCommentRecord, fromCommentRecord, setGlobalVerbose } from '@app/github/lib/utils';
import type {
  IssueCommandOptions,
  GitHubIssue,
  GitHubComment,
  GitHubTimelineEvent,
  IssueData,
  CommentData,
  TimelineEventData,
  CommentRecord,
  LinkedIssue,
} from '@app/github/types';
import logger from '@app/logger';

// Known bots
const KNOWN_BOTS = [
  'dependabot',
  'renovate',
  'github-actions',
  'vercel',
  'netlify',
  'codecov',
  'stale',
  'linear',
  'mergify',
  'semantic-release-bot',
  'greenkeeper',
  'snyk-bot',
];

/**
 * Check if a user is a bot
 */
function isBot(username: string, userType?: string): boolean {
  if (userType === 'Bot') return true;
  if (username.endsWith('[bot]')) return true;
  const lowerName = username.toLowerCase();
  return KNOWN_BOTS.some(bot => lowerName.includes(bot));
}

/**
 * Fetch issue data from GitHub API
 */
async function fetchIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
  const octokit = getOctokit();

  const { data } = await withRetry(
    () =>
      octokit.rest.issues.get({
        owner,
        repo,
        issue_number: number,
      }),
    { label: `GET /repos/${owner}/${repo}/issues/${number}` }
  );

  return data as GitHubIssue;
}

/**
 * Fetch comments with pagination
 */
async function fetchComments(
  owner: string,
  repo: string,
  number: number,
  options: {
    since?: string;
    perPage?: number;
    page?: number;
    all?: boolean;
  } = {}
): Promise<GitHubComment[]> {
  const octokit = getOctokit();
  const perPage = options.perPage || 100;

  if (options.all) {
    // Fetch all comments using pagination
    const allComments: GitHubComment[] = [];
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: number,
            per_page: perPage,
            page,
            since: options.since,
          }),
        { label: `GET /repos/${owner}/${repo}/issues/${number}/comments (page ${page})` }
      );

      allComments.push(...(data as GitHubComment[]));

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return allComments;
  }

  // Single page fetch
  const { data } = await withRetry(
    () =>
      octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: perPage,
        page: options.page || 1,
        since: options.since,
      }),
    { label: `GET /repos/${owner}/${repo}/issues/${number}/comments` }
  );

  return data as GitHubComment[];
}

/**
 * Fetch timeline events
 */
async function fetchTimelineEvents(
  owner: string,
  repo: string,
  number: number
): Promise<GitHubTimelineEvent[]> {
  const octokit = getOctokit();
  const events: GitHubTimelineEvent[] = [];
  let page = 1;

  while (true) {
    const { data } = await withRetry(
      () =>
        octokit.rest.issues.listEventsForTimeline({
          owner,
          repo,
          issue_number: number,
          per_page: 100,
          page,
        }),
      { label: `GET /repos/${owner}/${repo}/issues/${number}/timeline (page ${page})` }
    );

    events.push(...(data as GitHubTimelineEvent[]));

    if (data.length < 100) {
      break;
    }
    page++;
  }

  return events;
}

/**
 * Fetch linked issue details
 */
async function fetchLinkedIssue(owner: string, repo: string, number: number): Promise<LinkedIssue | null> {
  try {
    const octokit = getOctokit();
    const { data } = await withRetry(
      () =>
        octokit.rest.issues.get({
          owner,
          repo,
          issue_number: number,
        }),
      { label: `GET /repos/${owner}/${repo}/issues/${number} (linked)` }
    );

    return {
      number,
      title: data.title,
      state: data.state,
      linkType: 'related',
    };
  } catch (error) {
    logger.debug({ error, owner, repo, number }, 'Failed to fetch linked issue');
    return null;
  }
}

/**
 * Convert GitHub comment to our format
 */
function toCommentData(comment: GitHubComment, previousComments: { id: number; body: string }[]): CommentData {
  const username = comment.user?.login || 'unknown';
  const botFlag = isBot(username, comment.user?.type);

  // Process quotes
  const { processedBody } = processQuotes(comment.body);

  // Find reply target
  const firstQuoteMatch = comment.body.match(/^>\s*(.+)/m);
  let replyTo: number | undefined;
  if (firstQuoteMatch) {
    const target = findReplyTarget(firstQuoteMatch[1], previousComments);
    if (target) {
      replyTo = target;
    }
  }

  return {
    id: comment.id,
    nodeId: comment.node_id,
    author: username,
    body: processedBody,
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
    isBot: botFlag,
    htmlUrl: comment.html_url,
    replyTo,
  };
}


/**
 * Convert timeline event to our format
 */
function toTimelineEventData(event: GitHubTimelineEvent): TimelineEventData {
  let details = event.event;

  switch (event.event) {
    case 'labeled':
    case 'unlabeled':
      details = `${event.event} \`${event.label?.name}\``;
      break;
    case 'assigned':
    case 'unassigned':
      details = `${event.event} @${event.assignee?.login}`;
      break;
    case 'milestoned':
    case 'demilestoned':
      details = `${event.event} "${event.milestone?.title}"`;
      break;
    case 'renamed':
      details = `renamed from "${event.rename?.from}" to "${event.rename?.to}"`;
      break;
    case 'cross-referenced':
      if (event.source?.issue) {
        details = `referenced in #${event.source.issue.number} (${event.source.issue.state})`;
      }
      break;
    case 'closed':
      details = 'closed this';
      break;
    case 'reopened':
      details = 'reopened this';
      break;
    case 'merged':
      details = 'merged this';
      break;
  }

  return {
    id: String(event.id),
    event: event.event,
    actor: event.actor?.login || 'unknown',
    createdAt: event.created_at,
    details,
  };
}


/**
 * Main issue command handler
 */
export async function issueCommand(
  input: string,
  options: IssueCommandOptions
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
    console.error(chalk.red('Invalid input. Please provide a GitHub issue URL or number.'));
    process.exit(1);
  }

  const { owner, repo, number } = parsed;
  console.log(chalk.dim(`Fetching ${owner}/${repo}#${number}...`));
  verbose(options, `Parsed: owner=${owner}, repo=${repo}, number=${number}`);

  // Get or create repo in cache
  const repoRecord = getOrCreateRepo(owner, repo);

  // Check cache
  const cachedIssue = getIssue(repoRecord.id, number);
  const metadata = cachedIssue ? getFetchMetadata(cachedIssue.id) : null;

  const shouldFetchFresh = options.full || !cachedIssue;
  const shouldRefresh = options.refresh || shouldFetchFresh;

  // Fetch issue data
  let issue: GitHubIssue;
  if (shouldRefresh) {
    console.log(chalk.dim('Fetching issue from GitHub...'));
    issue = await fetchIssue(owner, repo, number);

    // Update cache
    upsertIssue({
      repo_id: repoRecord.id,
      number,
      type: issue.pull_request ? 'pr' : 'issue',
      title: issue.title,
      body: issue.body || '',
      state: issue.state,
      author: issue.user?.login || 'unknown',
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      last_fetched: new Date().toISOString(),
      last_comment_cursor: null,
    });
  } else {
    // Use cached data
    issue = {
      id: cachedIssue!.id,
      node_id: String(cachedIssue!.id),
      number: cachedIssue!.number,
      title: cachedIssue!.title,
      body: cachedIssue!.body,
      state: cachedIssue!.state,
      user: { login: cachedIssue!.author, id: 0, type: 'User' },
      created_at: cachedIssue!.created_at,
      updated_at: cachedIssue!.updated_at,
      closed_at: cachedIssue!.closed_at,
      labels: [],
      assignees: [],
      milestone: null,
      comments: 0,
    };
  }

  // Get issue ID from cache
  const issueRecord = getIssue(repoRecord.id, number)!;

  // Fetch comments
  let comments: CommentData[] = [];
  const wantsComments = options.comments !== false;

  if (wantsComments) {
    // Determine fetch strategy
    const sinceId = options.since ? extractCommentId(options.since) : null;
    const afterDate = options.after ? parseDate(options.after) : null;
    const beforeDate = options.before ? parseDate(options.before) : null;

    if (shouldFetchFresh || options.all) {
      // Fetch all comments from API
      console.log(chalk.dim('Fetching comments...'));

      const sinceStr = afterDate?.toISOString() ||
        (metadata?.last_comment_date && !options.full ? metadata.last_comment_date : undefined);

      const apiComments = await fetchComments(owner, repo, number, {
        all: options.all || options.full,
        since: sinceStr,
      });

      // Convert and store
      const previousComments: { id: number; body: string }[] = [];
      const commentData: CommentData[] = [];

      for (const apiComment of apiComments) {
        const converted = toCommentData(apiComment, previousComments);
        commentData.push(converted);
        previousComments.push({ id: apiComment.id, body: apiComment.body });
      }

      // Store in cache
      const records = commentData.map(c => toCommentRecord(c, issueRecord.id));
      upsertComments(records);

      // Update metadata
      updateFetchMetadata(issueRecord.id, {
        last_full_fetch: options.full ? new Date().toISOString() : undefined,
        last_incremental_fetch: new Date().toISOString(),
        total_comments: apiComments.length + (metadata?.total_comments || 0),
        last_comment_date: apiComments.length > 0
          ? apiComments[apiComments.length - 1].created_at
          : metadata?.last_comment_date,
      });

      comments = commentData;
    } else {
      // Use cache with filters
      let cachedRecords: CommentRecord[];

      if (options.last) {
        cachedRecords = getLastNComments(issueRecord.id, options.last, {
          excludeBots: options.noBots,
          minReactions: options.minReactions,
          author: options.author,
        });
      } else {
        cachedRecords = getCachedComments(issueRecord.id, {
          limit: options.limit || 30,
          since: sinceId ? String(sinceId) : undefined,
          after: afterDate?.toISOString(),
          before: beforeDate?.toISOString(),
          minReactions: options.minReactions,
          author: options.author,
          excludeBots: options.noBots,
        });
      }

      comments = cachedRecords.map(fromCommentRecord);
    }

    // Apply post-fetch filters
    if (options.noBots) {
      comments = comments.filter(c => !c.isBot);
    }

    if (options.minReactions !== undefined) {
      comments = comments.filter(c => c.reactions.total_count >= options.minReactions!);
    }

    if (options.author) {
      comments = comments.filter(c => c.author.toLowerCase() === options.author!.toLowerCase());
    }

    // Apply first/last/limit
    if (options.first && options.first < comments.length) {
      comments = comments.slice(0, options.first);
    } else if (options.last && options.last < comments.length) {
      comments = comments.slice(-options.last);
    } else if (!options.all && options.limit && options.limit < comments.length) {
      comments = comments.slice(0, options.limit);
    }
  }

  // Fetch timeline events if requested
  let events: TimelineEventData[] = [];
  if (options.includeEvents) {
    console.log(chalk.dim('Fetching timeline events...'));
    const apiEvents = await fetchTimelineEvents(owner, repo, number);
    events = apiEvents
      .filter(e => e.event !== 'commented') // Don't duplicate comments
      .map(toTimelineEventData);

    // Store in cache
    upsertTimelineEvents(
      events.map(e => ({
        id: e.id,
        issue_id: issueRecord.id,
        event_type: e.event,
        actor: e.actor,
        created_at: e.createdAt,
        data_json: JSON.stringify({ details: e.details }),
      }))
    );
  }

  // Resolve cross-references (automatic unless --no-resolve-refs)
  let linkedIssues: LinkedIssue[] = [];
  const shouldResolveRefs = !options.noResolveRefs && issue.body;
  if (shouldResolveRefs) {
    const refs = detectCrossReferences(issue.body!);
    if (refs.length > 0) {
      verbose(options, `Found ${refs.length} cross-references to resolve`);
      console.log(chalk.dim(`Resolving ${refs.length} cross-references...`));

      for (const ref of refs) {
        verbose(options, `Fetching linked issue #${ref.number}`);
        const linked = await fetchLinkedIssue(owner, repo, ref.number);
        if (linked) {
          linkedIssues.push({ ...linked, linkType: ref.type });
        }
      }
    }
  }

  // Build output data
  const totalInCache = getCommentCount(issueRecord.id, options.noBots);
  const stats = options.stats ? calculateStats(comments, totalInCache) : undefined;

  const outputData: IssueData = {
    owner,
    repo,
    issue,
    comments,
    events,
    stats,
    linkedIssues: linkedIssues.length > 0 ? linkedIssues : undefined,
    fetchedAt: new Date().toISOString(),
    cacheCursor: metadata?.last_comment_date || undefined,
  };

  // Format output
  const format = options.format || 'ai';
  verbose(options, `Output format: ${format}`);

  // For AI format: auto-save full content and show summary
  if (format === 'ai') {
    // Save full markdown content to file
    const localDir = options.output ? join(options.output, '..') : join(process.cwd(), '.claude', 'github');
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }
    const filename = options.output || join(localDir, `${owner}-${repo}-${number}.md`);

    // Generate full markdown content for the file
    const fullContent = formatIssue(outputData, 'md', { noIndex: options.noIndex });
    await Bun.write(filename, fullContent);
    verbose(options, `Full content saved to: ${filename}`);

    // Generate AI summary for console output
    const summary = formatIssue(outputData, 'ai', { noIndex: options.noIndex, filePath: filename });
    console.log(summary);
  } else {
    // For md and json formats
    const output = formatIssue(outputData, format, { noIndex: options.noIndex });

    if (options.output) {
      await Bun.write(options.output, output);
      console.log(chalk.green(`✔ Output written to ${options.output}`));
    } else if (options.saveLocally) {
      const localDir = join(process.cwd(), '.claude', 'github');
      if (!existsSync(localDir)) {
        mkdirSync(localDir, { recursive: true });
      }
      const filename = `${owner}-${repo}-${number}.${format === 'json' ? 'json' : 'md'}`;
      const filepath = join(localDir, filename);
      await Bun.write(filepath, output);
      console.log(chalk.green(`✔ Output saved to ${filepath}`));
    } else {
      console.log(output);
    }
  }

  // Show summary
  verbose(options, `Completed: ${comments.length} comments, ${events.length} events, ${linkedIssues.length} linked issues`);
  console.log(chalk.dim(`\nFetched: ${comments.length} comments${events.length > 0 ? `, ${events.length} events` : ''}${linkedIssues.length > 0 ? `, ${linkedIssues.length} linked` : ''}`));
}

/**
 * Create issue command
 */
export function createIssueCommand(): Command {
  const cmd = new Command('issue')
    .description('Fetch GitHub issue details and comments')
    .argument('<input>', 'Issue number or URL')
    .option('-r, --repo <owner/repo>', 'Repository (auto-detected from URL or git)')
    .option('-c, --comments', 'Include comments (default: true)', true)
    .option('--no-comments', 'Exclude comments')
    .option('-L, --limit <n>', 'Limit comments', parseInt)
    .option('--all', 'Fetch all comments')
    .option('--first <n>', 'First N comments only', parseInt)
    .option('--last <n>', 'Last N comments only', parseInt)
    .option('--since <id|url>', 'Comments after this ID/URL')
    .option('--after <date>', 'Comments after date')
    .option('--before <date>', 'Comments before date')
    .option('--min-reactions <n>', 'Min reaction count filter', parseInt)
    .option('--author <user>', 'Filter by author')
    .option('--no-bots', 'Exclude bot comments')
    .option('--include-events', 'Include timeline events')
    .option('--no-resolve-refs', 'Skip resolving linked issues (auto by default)')
    .option('--full', 'Force full refetch')
    .option('--refresh', 'Update cache with new data')
    .option('--save-locally', 'Save to .claude/github/')
    .option('-f, --format <format>', 'Output format: ai|md|json', 'ai')
    .option('-o, --output <file>', 'Custom output path')
    .option('--stats', 'Show comment statistics')
    .option('--no-index', 'Exclude index from output')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (input, opts) => {
      try {
        await issueCommand(input, opts);
      } catch (error) {
        logger.error({ error }, 'Issue command failed');
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return cmd;
}
