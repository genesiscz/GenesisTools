#!/usr/bin/env bun

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { program } from 'commander';

// =============================================================================
// Types
// =============================================================================

interface RepoInfo {
  owner: string;
  repo: string;
}

interface PRInput extends RepoInfo {
  prNumber: number;
}

interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  diffHunk: string | null;
}

interface Thread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: Comment[];
}

interface PRInfo {
  title: string;
  state: string;
  threads: Thread[];
}

interface ParsedThread {
  threadId: string;
  threadNumber: number;
  status: 'resolved' | 'unresolved';
  severity: 'high' | 'medium' | 'low';
  file: string;
  line: number | null;
  author: string;
  title: string;
  issue: string;
  diffHunk: string | null;
  suggestedCode: string | null;
  firstCommentId: string;
  replies: { author: string; body: string; id: string }[];
}

// =============================================================================
// Colors
// =============================================================================

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

function c(text: string, ...colorCodes: (keyof typeof colors)[]): string {
  const codes = colorCodes.map((code) => colors[code]).join('');
  return `${codes}${text}${colors.reset}`;
}

// =============================================================================
// Token Management
// =============================================================================

function getGitHubToken(): string {
  // First try environment variable
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  // Fallback: try to get token from gh CLI
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (token) {
      return token;
    }
  } catch {
    // gh CLI not available or not authenticated
  }

  throw new Error(
    'No GitHub token found.\n\n' +
      'Options:\n' +
      '  1. Set GITHUB_TOKEN environment variable\n' +
      '  2. Authenticate with gh CLI: gh auth login\n\n' +
      'To create a token manually:\n' +
      '  1. Go to https://github.com/settings/tokens\n' +
      '  2. Generate a new token with "repo" scope\n' +
      '  3. Export it: export GITHUB_TOKEN=your_token_here'
  );
}

// =============================================================================
// Input Parsing
// =============================================================================

function getRepoFromGitRemote(): RepoInfo {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    throw new Error(`Could not parse git remote URL: ${remoteUrl}`);
  } catch {
    throw new Error(
      'Could not detect repository from git remote. Use a full GitHub URL instead.\n' +
        'Example: tools github-pr https://github.com/owner/repo/pull/123'
    );
  }
}

function parseInput(input: string): PRInput {
  // Full URL: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: parseInt(urlMatch[3], 10),
    };
  }

  // PR number only
  const prNumber = parseInt(input, 10);
  if (!isNaN(prNumber) && prNumber > 0) {
    const repoInfo = getRepoFromGitRemote();
    return { ...repoInfo, prNumber };
  }

  throw new Error(
    `Invalid input: "${input}"\n` +
      'Expected: PR number (e.g., 137) or full URL (e.g., https://github.com/owner/repo/pull/137)'
  );
}

// =============================================================================
// GitHub API
// =============================================================================

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        title
        state
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              isResolved
              path
              line
              startLine
              comments(first: 50) {
                edges {
                  node {
                    id
                    author {
                      login
                    }
                    body
                    createdAt
                    diffHunk
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchGitHubGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-pr-tool',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { data?: unknown; errors?: { message: string }[] };

  if (json.errors) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  return json.data;
}

interface GraphQLResponse {
  repository: {
    pullRequest: {
      title: string;
      state: string;
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        edges: Array<{
          node: {
            id: string;
            isResolved: boolean;
            path: string;
            line: number | null;
            startLine: number | null;
            comments: {
              edges: Array<{
                node: {
                  id: string;
                  author: { login: string } | null;
                  body: string;
                  createdAt: string;
                  diffHunk: string | null;
                };
              }>;
            };
          };
        }>;
      };
    } | null;
  };
}

async function fetchPRInfo(token: string, owner: string, repo: string, prNumber: number): Promise<PRInfo> {
  const allThreads: Thread[] = [];
  let cursor: string | null = null;
  let title = '';
  let state = '';

  do {
    const data = (await fetchGitHubGraphQL(token, REVIEW_THREADS_QUERY, {
      owner,
      repo,
      pr: prNumber,
      cursor,
    })) as GraphQLResponse;

    const pr = data.repository.pullRequest;
    if (!pr) {
      throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
    }

    title = pr.title;
    state = pr.state;

    for (const edge of pr.reviewThreads.edges) {
      const node = edge.node;
      allThreads.push({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        startLine: node.startLine,
        comments: node.comments.edges.map((ce) => ({
          id: ce.node.id,
          author: ce.node.author?.login ?? 'ghost',
          body: ce.node.body,
          createdAt: ce.node.createdAt,
          diffHunk: ce.node.diffHunk,
        })),
      });
    }

    cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (cursor);

  return { title, state, threads: allThreads };
}

// =============================================================================
// GitHub API - Mutations
// =============================================================================

async function replyToThread(
  token: string,
  pullRequestReviewThreadId: string,
  body: string
): Promise<string> {
  const query = `
    mutation($pullRequestReviewThreadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $pullRequestReviewThreadId, body: $body}) {
        comment {
          id
        }
      }
    }
  `;

  const data = (await fetchGitHubGraphQL(token, query, {
    pullRequestReviewThreadId,
    body,
  })) as { addPullRequestReviewThreadReply: { comment: { id: string } } };

  return data.addPullRequestReviewThreadReply.comment.id;
}

async function markThreadResolved(token: string, threadId: string): Promise<boolean> {
  const query = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread {
          isResolved
        }
      }
    }
  `;

  try {
    await fetchGitHubGraphQL(token, query, { threadId });
    return true;
  } catch (error) {
    console.error(`Failed to resolve thread: ${error}`);
    return false;
  }
}

// =============================================================================
// Thread Parsing
// =============================================================================

/**
 * Trim a diff hunk to show only context around the target line.
 * GitHub's API returns the entire file diff for new files, but we want
 * to show only ~4 lines of context around the comment line (like GitHub UI).
 */
function trimDiffHunk(diffHunk: string | null, targetLine: number | null, contextLines: number = 4): string | null {
  if (!diffHunk || !targetLine) return diffHunk;

  const lines = diffHunk.split('\n');
  if (lines.length === 0) return diffHunk;

  // Parse the @@ header to get starting line number
  // Format: @@ -old_start,old_count +new_start,new_count @@ optional context
  const headerMatch = lines[0].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!headerMatch) return diffHunk;

  const newStartLine = parseInt(headerMatch[2], 10);

  // Track line numbers and collect lines within the context window
  // Include context lines both BEFORE and AFTER the target line
  let currentLine = newStartLine;
  const relevantLines: { line: string; lineNum: number }[] = [];
  const minLine = targetLine - contextLines;
  const maxLine = targetLine + contextLines;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Removed lines (-) don't increment the new file line counter
    if (line.startsWith('-')) {
      // Include removed lines if they're in our context window
      if (currentLine >= minLine && currentLine <= maxLine) {
        relevantLines.push({ line, lineNum: currentLine });
      }
      continue;
    }

    // Context and added lines increment the counter
    if (currentLine >= minLine && currentLine <= maxLine) {
      relevantLines.push({ line, lineNum: currentLine });
    }

    // Increment line number for context lines and added lines
    if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  if (relevantLines.length === 0) return diffHunk;

  // Build new header with the actual line range we're showing
  const firstLineNum = relevantLines[0].lineNum;
  const lineCount = relevantLines.length;
  const newHeader = `@@ -${firstLineNum},${lineCount} +${firstLineNum},${lineCount} @@`;

  return [newHeader, ...relevantLines.map((r) => r.line)].join('\n');
}

function detectSeverity(body: string): 'high' | 'medium' | 'low' {
  const lowerBody = body.toLowerCase();

  // Check for severity indicators in the comment
  if (
    body.includes('high-priority') ||
    body.includes('![high]') ||
    lowerBody.includes('critical') ||
    lowerBody.includes('security vulnerability') ||
    lowerBody.includes('bug')
  ) {
    return 'high';
  }

  if (
    body.includes('medium-priority') ||
    body.includes('![medium]') ||
    lowerBody.includes('should') ||
    lowerBody.includes('consider') ||
    lowerBody.includes('suggestion')
  ) {
    return 'medium';
  }

  return 'low';
}

function extractTitle(body: string): string {
  // Try to extract a title from the first line or markdown heading
  const lines = body.split('\n').filter((l) => l.trim());

  // Skip image badges like ![high]
  const firstContent = lines.find((l) => !l.startsWith('!['));
  if (firstContent) {
    // Remove markdown formatting
    const cleaned = firstContent
      .replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();
    // Truncate if too long
    return cleaned.length > 60 ? cleaned.substring(0, 57) + '...' : cleaned;
  }

  return 'Review Comment';
}

function extractSuggestion(body: string): string | null {
  // GitHub suggestion format
  const suggestionMatch = body.match(/```suggestion\r?\n([\s\S]*?)```/);
  if (suggestionMatch) {
    return suggestionMatch[1];
  }

  // Code block with php/typescript etc that looks like a fix
  const codeBlockMatch = body.match(/```(?:php|typescript|ts|js|javascript)?\r?\n([\s\S]*?)```/);
  if (codeBlockMatch && (body.toLowerCase().includes('should') || body.toLowerCase().includes('instead'))) {
    return codeBlockMatch[1];
  }

  return null;
}

function extractIssue(body: string): string {
  // Only remove severity badges like ![high](url) but KEEP code examples
  const issue = body
    .replace(/!\[(high|medium|low)\]\([^)]*\)/gi, '') // Remove severity badges only
    .trim();

  return issue;
}

function parseThreads(threads: Thread[]): ParsedThread[] {
  return threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread, index) => {
      const firstComment = thread.comments[0];
      const replies = thread.comments.slice(1).map((c) => ({
        author: c.author,
        body: c.body,
        id: c.id,
      }));

      return {
        threadId: thread.id,
        threadNumber: index + 1,
        status: thread.isResolved ? 'resolved' : 'unresolved',
        severity: detectSeverity(firstComment.body),
        file: thread.path,
        line: thread.line,
        author: firstComment.author,
        title: extractTitle(firstComment.body),
        issue: extractIssue(firstComment.body),
        diffHunk: trimDiffHunk(firstComment.diffHunk, thread.line),
        suggestedCode: extractSuggestion(firstComment.body),
        firstCommentId: firstComment.id,
        replies,
      };
    });
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatDiffHunk(diffHunk: string | null): string {
  if (!diffHunk) return '';

  const lines = diffHunk.split('\n');
  return lines
    .map((line) => {
      if (line.startsWith('+')) {
        return c(line, 'green');
      } else if (line.startsWith('-')) {
        return c(line, 'red');
      } else if (line.startsWith('@@')) {
        return c(line, 'cyan');
      }
      return c(line, 'dim');
    })
    .join('\n');
}

function formatSuggestion(suggestion: string | null, diffHunk: string | null): string {
  if (!suggestion) return '';

  // Try to extract the original code from diffHunk to create a proper diff
  const suggestionLines = suggestion.split('\n');

  let output = '\n' + c('Suggested Change:', 'bold', 'yellow') + '\n';
  output += c('```diff', 'dim') + '\n';

  // If we have a diff hunk, try to find the lines being replaced
  if (diffHunk) {
    const hunkLines = diffHunk.split('\n');
    const removedLines = hunkLines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    if (removedLines.length > 0) {
      for (const line of removedLines) {
        output += c(line, 'red') + '\n';
      }
    }
  }

  // Show the suggestion as added lines
  for (const line of suggestionLines) {
    if (line.trim()) {
      output += c('+' + line, 'green') + '\n';
    }
  }

  output += c('```', 'dim') + '\n';
  return output;
}

function formatThread(thread: ParsedThread): string {
  const severityIcon = thread.severity === 'high' ? 'RED' : thread.severity === 'medium' ? 'YEL' : 'GRN';
  const severityText = thread.severity.toUpperCase();
  const statusIcon = thread.status === 'resolved' ? 'OK' : 'X';
  const statusText = thread.status === 'resolved' ? 'RESOLVED' : 'UNRESOLVED';

  let output = '\n';
  output += c('='.repeat(90), 'cyan') + '\n';
  output += c(`[THREAD #${thread.threadNumber}] `, 'bold') + `${severityIcon} ${c(severityText, 'bold')} - ${thread.title}\n`;
  output += c('='.repeat(90), 'cyan') + '\n';

  output += `${c('Status:', 'bold')}   ${statusIcon} ${statusText}`;
  if (thread.replies.length > 0) {
    output += c(` (${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'})`, 'dim');
  }
  output += '\n';

  output += `${c('File:', 'bold')}     ${c(thread.file, 'cyan')}`;
  if (thread.line) {
    output += c(`:${thread.line}`, 'yellow');
  }
  output += '\n';

  output += `${c('Author:', 'bold')}   ${thread.author}\n`;
  output += `${c('Thread ID:', 'bold')} ${c(thread.threadId, 'dim')}\n`;
  output += `${c('First Comment ID:', 'bold')} ${c(thread.firstCommentId, 'dim')}\n`;

  output += `\n${c('Issue:', 'bold', 'magenta')}\n${thread.issue}\n`;

  // Show diff context if available
  if (thread.diffHunk) {
    output += `\n${c('Code Context:', 'bold', 'blue')}\n`;
    output += formatDiffHunk(thread.diffHunk) + '\n';
  }

  // Show suggestion if available
  if (thread.suggestedCode) {
    output += formatSuggestion(thread.suggestedCode, thread.diffHunk);
  }

  // Show replies if any
  if (thread.replies.length > 0) {
    output += `\n${c('Replies:', 'bold', 'cyan')}\n`;
    for (const reply of thread.replies) {
      output += c(`  > ${reply.author} (${c(reply.id, 'dim')}): `, 'dim') + reply.body.split('\n')[0].substring(0, 60) + '\n';
    }
  }

  return output;
}

function formatSummary(
  owner: string,
  repo: string,
  prNumber: number,
  title: string,
  state: string,
  threads: ParsedThread[],
  fullStats?: ThreadStats
): string {
  const stats = fullStats ?? calculateStats(threads);
  const showing = threads.length;

  let output = '\n';
  output += c('+' + '='.repeat(88) + '+', 'cyan') + '\n';
  output += c('|', 'cyan') + c(`  PR #${prNumber}: `, 'bold') + title.substring(0, 70).padEnd(78) + c('|', 'cyan') + '\n';
  output += c('|', 'cyan') + `  Repository: ${owner}/${repo}`.padEnd(87) + c('|', 'cyan') + '\n';
  output += c('|', 'cyan') + `  Status: ${state}`.padEnd(87) + c('|', 'cyan') + '\n';
  output += c('+' + '='.repeat(88) + '+', 'cyan') + '\n';

  output += '\n';
  const showingText = showing !== stats.total ? ` (showing ${showing})` : '';
  output += c('Summary: ', 'bold') + `${stats.total} threads${showingText} (`;
  output += c(`${stats.unresolved} unresolved`, stats.unresolved > 0 ? 'red' : 'green') + ', ';
  output += c(`${stats.resolved} resolved`, 'green') + ')\n';
  output += `   HIGH: ${stats.high}  |  MEDIUM: ${stats.medium}  |  LOW: ${stats.low}\n`;

  return output;
}

// =============================================================================
// Markdown Output Formatting
// =============================================================================

function formatMarkdownThread(thread: ParsedThread): string {
  const severityEmoji = thread.severity === 'high' ? '[HIGH]' : thread.severity === 'medium' ? '[MED]' : '[LOW]';
  const statusEmoji = thread.status === 'resolved' ? '[OK]' : '[X]';

  let output = `### Thread #${thread.threadNumber}: ${thread.title}\n\n`;

  output += `| Property | Value |\n`;
  output += `|----------|-------|\n`;
  output += `| **Status** | ${statusEmoji} ${thread.status.toUpperCase()} |\n`;
  output += `| **Severity** | ${severityEmoji} ${thread.severity.toUpperCase()} |\n`;
  output += `| **File** | \`${thread.file}${thread.line ? `:${thread.line}` : ''}\` |\n`;
  output += `| **Author** | @${thread.author} |\n`;
  output += `| **Thread ID** | \`${thread.threadId}\` |\n`;
  output += `| **First Comment ID** | \`${thread.firstCommentId}\` |\n`;
  if (thread.replies.length > 0) {
    output += `| **Replies** | ${thread.replies.length} |\n`;
  }
  output += '\n';

  output += `**Issue:**\n\n${thread.issue}\n\n`;

  if (thread.diffHunk) {
    output += `<details>\n<summary>Code Context</summary>\n\n\`\`\`diff\n${thread.diffHunk}\n\`\`\`\n\n</details>\n\n`;
  }

  if (thread.suggestedCode) {
    output += `**Suggested Change:**\n\n\`\`\`suggestion\n${thread.suggestedCode}\`\`\`\n\n`;
  }

  if (thread.replies.length > 0) {
    output += `**Replies:**\n\n`;
    for (const reply of thread.replies) {
      const replyPreview = reply.body.split('\n')[0].substring(0, 100);
      output += `- **@${reply.author}** (\`${reply.id}\`): ${replyPreview}${reply.body.length > 100 ? '...' : ''}\n`;
    }
    output += '\n';
  }

  output += '---\n\n';
  return output;
}

interface ThreadStats {
  total: number;
  resolved: number;
  unresolved: number;
  high: number;
  medium: number;
  low: number;
}

function calculateStats(threads: ParsedThread[]): ThreadStats {
  return {
    total: threads.length,
    resolved: threads.filter((t) => t.status === 'resolved').length,
    unresolved: threads.filter((t) => t.status === 'unresolved').length,
    high: threads.filter((t) => t.severity === 'high').length,
    medium: threads.filter((t) => t.severity === 'medium').length,
    low: threads.filter((t) => t.severity === 'low').length,
  };
}

function formatMarkdownOutput(
  owner: string,
  repo: string,
  prNumber: number,
  title: string,
  state: string,
  threads: ParsedThread[],
  groupByFile: boolean,
  fullStats?: ThreadStats
): string {
  // Use full stats if provided, otherwise calculate from threads
  const stats = fullStats ?? calculateStats(threads);
  const showing = threads.length;

  let output = `# PR Review: #${prNumber}\n\n`;
  output += `**${title}**\n\n`;
  output += `| | |\n`;
  output += `|---|---|\n`;
  output += `| **Repository** | [${owner}/${repo}](https://github.com/${owner}/${repo}/pull/${prNumber}) |\n`;
  output += `| **State** | ${state} |\n`;
  output += `| **Generated** | ${new Date().toISOString()} |\n\n`;

  output += `## Summary\n\n`;
  output += `| Metric | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Total Threads | ${stats.total}${showing !== stats.total ? ` (showing ${showing})` : ''} |\n`;
  output += `| [X] Unresolved | ${stats.unresolved} |\n`;
  output += `| [OK] Resolved | ${stats.resolved} |\n`;
  output += `| [HIGH] High Priority | ${stats.high} |\n`;
  output += `| [MED] Medium Priority | ${stats.medium} |\n`;
  output += `| [LOW] Low Priority | ${stats.low} |\n\n`;

  if (threads.length === 0) {
    output += `*No review comments found.*\n`;
    return output;
  }

  output += `## Review Threads\n\n`;

  if (groupByFile) {
    const byFile = new Map<string, ParsedThread[]>();
    for (const thread of threads) {
      const existing = byFile.get(thread.file) ?? [];
      existing.push(thread);
      byFile.set(thread.file, existing);
    }

    for (const [file, fileThreads] of byFile) {
      output += `## \`${file}\`\n\n`;
      output += `*${fileThreads.length} thread(s)*\n\n`;
      for (const thread of fileThreads) {
        output += formatMarkdownThread(thread);
      }
    }
  } else {
    for (const thread of threads) {
      output += formatMarkdownThread(thread);
    }
  }

  return output;
}

function saveMarkdownFile(content: string, prNumber: number): string {
  const now = new Date();
  const datetime = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `pr-${prNumber}-${datetime}.md`;
  const reviewsDir = join(process.cwd(), '.claude', 'reviews');
  const filePath = join(reviewsDir, filename);

  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  program
    .name('github-pr')
    .description(
      `Fetch and display GitHub PR review comments

Examples:
  $ tools github-pr 137                                              # Show review comments for PR #137 (auto-detect repo)
  $ tools github-pr https://github.com/owner/repo/pull/137           # Show review comments from URL
  $ tools github-pr 137 -u                                           # Show only unresolved comments
  $ tools github-pr 137 --json                                       # Output as JSON
  $ tools github-pr 137 --md                                         # Save as markdown file
  $ tools github-pr 137 -r "ok" -t <thread-id>                       # Reply to a thread
  $ tools github-pr 137 --resolve-thread -t <thread-id>              # Mark a thread as resolved
  $ tools github-pr 137 -r "fixed" --resolve-thread -t <thread-id>   # Reply AND resolve in one command`
    )
    .argument('<pr>', 'PR number or full GitHub URL')
    .option('-j, --json', 'Output as JSON', false)
    .option('-u, --unresolved-only', 'Show only unresolved threads', false)
    .option('-g, --group-by-file', 'Group threads by file path', false)
    .option('-m, --md', 'Save output as markdown file to .claude/reviews/', false)
    .option('-r, --respond <message>', 'Reply to a comment with this message')
    .option('-t, --thread-id <id>', 'Thread ID for operations like resolve')
    .option('-R, --resolve-thread', 'Mark a thread as resolved', false)
    .option('--resolve', 'Alias for --resolve-thread', false);

  program.parse();

  const prInput = program.args[0];
  const options = program.opts();
  const jsonOutput = options.json;
  const unresolvedOnly = options.unresolvedOnly;
  const groupByFile = options.groupByFile;
  const mdOutput = options.md;
  const respondMessage = options.respond;
  const threadId = options.threadId;
  const resolveThreadOpt = options.resolveThread || options.resolve;

  if (!prInput) {
    program.help();
  }

  // Get GitHub token (from env or gh CLI)
  let token: string;
  try {
    token = getGitHubToken();
  } catch (error) {
    console.error(c(`Error: ${(error as Error).message}`, 'red'));
    process.exit(1);
  }

  // Parse input
  let input: PRInput;
  try {
    input = parseInput(prInput);
  } catch (error) {
    console.error(c(`Error: ${(error as Error).message}`, 'red'));
    process.exit(1);
  }

  // Handle respond and/or resolve operations
  if ((respondMessage || resolveThreadOpt) && threadId) {
    // Reply first if message provided
    if (respondMessage) {
      try {
        console.error(c(`Replying to thread ${threadId}...`, 'dim'));
        const replyId = await replyToThread(token, threadId, respondMessage);
        console.log(c(`✓ Reply posted successfully! Reply ID: ${replyId}`, 'green'));
      } catch (error) {
        console.error(c(`Error replying to thread: ${(error as Error).message}`, 'red'));
        process.exit(1);
      }
    }

    // Then resolve if requested
    if (resolveThreadOpt) {
      try {
        console.error(c(`Resolving thread ${threadId}...`, 'dim'));
        const resolved = await markThreadResolved(token, threadId);
        if (resolved) {
          console.log(c(`✓ Thread resolved successfully!`, 'green'));
        } else {
          console.log(c(`✗ Failed to resolve thread`, 'red'));
        }
      } catch (error) {
        console.error(c(`Error resolving thread: ${(error as Error).message}`, 'red'));
        process.exit(1);
      }
    }

    return;
  }

  // Fetch PR info (only show status for non-JSON output)
  if (!jsonOutput) {
    console.error(c(`Fetching PR #${input.prNumber} from ${input.owner}/${input.repo}...`, 'dim'));
  }

  let prInfo: PRInfo;
  try {
    prInfo = await fetchPRInfo(token, input.owner, input.repo, input.prNumber);
  } catch (error) {
    console.error(c(`Error: ${(error as Error).message}`, 'red'));
    process.exit(1);
  }

  // Parse threads
  const allThreads = parseThreads(prInfo.threads);
  const fullStats = calculateStats(allThreads);

  // Filter if requested
  let parsedThreads = allThreads;
  if (unresolvedOnly) {
    parsedThreads = allThreads.filter((t) => t.status === 'unresolved');
  }

  // JSON output
  if (jsonOutput) {
    const output = JSON.stringify(
      {
        repository: `${input.owner}/${input.repo}`,
        prNumber: input.prNumber,
        title: prInfo.title,
        state: prInfo.state,
        threads: parsedThreads,
      },
      null,
      2
    );
    // Write to stdout and wait for flush
    process.stdout.write(output + '\n');
    return;
  }

  // Markdown output
  if (mdOutput) {
    const mdContent = formatMarkdownOutput(
      input.owner,
      input.repo,
      input.prNumber,
      prInfo.title,
      prInfo.state,
      parsedThreads,
      groupByFile,
      fullStats
    );
    const filePath = saveMarkdownFile(mdContent, input.prNumber);
    console.log(filePath);
    return;
  }

  // Terminal output
  console.log(formatSummary(input.owner, input.repo, input.prNumber, prInfo.title, prInfo.state, parsedThreads, fullStats));

  if (parsedThreads.length === 0) {
    console.log(c('\nNo review comments found.', 'dim'));
    return;
  }

  // Group by file if requested
  if (groupByFile) {
    const byFile = new Map<string, ParsedThread[]>();
    for (const thread of parsedThreads) {
      const existing = byFile.get(thread.file) ?? [];
      existing.push(thread);
      byFile.set(thread.file, existing);
    }

    for (const [file, threads] of byFile) {
      console.log('\n' + c('-'.repeat(90), 'dim'));
      console.log(c(`FILE: ${file}`, 'bold', 'cyan') + c(` (${threads.length} threads)`, 'dim'));
      console.log(c('-'.repeat(90), 'dim'));

      for (const thread of threads) {
        console.log(formatThread(thread));
      }
    }
  } else {
    for (const thread of parsedThreads) {
      console.log(formatThread(thread));
    }
  }
}

main().catch((error: Error) => {
  console.error(c(`Unexpected error: ${error.message}`, 'red'));
  process.exit(1);
});
