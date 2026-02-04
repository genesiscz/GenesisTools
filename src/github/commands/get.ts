// Get file content command implementation

import { Command } from 'commander';
import chalk from 'chalk';
import clipboardy from 'clipboardy';
import { getOctokit } from '@app/github/lib/octokit';
import { withRetry } from '@app/github/lib/rate-limit';
import { parseGitHubFileUrl, buildRawGitHubUrl } from '@app/github/lib/url-parser';
import { verbose, setGlobalVerbose } from '@app/github/lib/utils';
import logger from '@app/logger';

interface GetOptions {
  ref?: string;
  output?: string;
  clipboard?: boolean;
  lines?: string;
  raw?: boolean;
  verbose?: boolean;
}

interface FileContent {
  content: string;
  path: string;
  ref: string;
  size: number;
  sha: string;
  url: string;
}

/**
 * Fetch file content from GitHub
 */
async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  useRaw: boolean
): Promise<FileContent> {
  if (useRaw) {
    // Fetch via raw.githubusercontent.com (faster, no base64 decoding)
    const rawUrl = buildRawGitHubUrl(owner, repo, ref, path);
    verbose({ verbose: true }, `Fetching from: ${rawUrl}`);

    const response = await fetch(rawUrl);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`File not found: ${path} at ref ${ref}`);
      }
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    return {
      content,
      path,
      ref,
      size: content.length,
      sha: '', // Not available from raw URL
      url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
    };
  }

  // Fetch via GitHub API (includes metadata, handles larger files)
  const octokit = getOctokit();

  verbose({ verbose: true }, `Fetching via API: ${owner}/${repo}/${path}@${ref}`);

  const { data } = await withRetry(
    () =>
      octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      }),
    { label: `GET /repos/${owner}/${repo}/contents/${path}` }
  );

  // Handle directory response
  if (Array.isArray(data)) {
    throw new Error(`Path is a directory, not a file: ${path}`);
  }

  // Handle file response
  if (data.type !== 'file') {
    throw new Error(`Unexpected content type: ${data.type}`);
  }

  // Decode base64 content
  const content = Buffer.from(data.content, 'base64').toString('utf-8');

  return {
    content,
    path: data.path,
    ref,
    size: data.size,
    sha: data.sha,
    url: data.html_url || `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
  };
}

/**
 * Extract specific lines from content
 */
function extractLines(content: string, lineStart?: number, lineEnd?: number): string {
  if (!lineStart) {
    return content;
  }

  const lines = content.split('\n');
  const start = Math.max(0, lineStart - 1); // Convert to 0-indexed
  const end = lineEnd ? Math.min(lines.length, lineEnd) : lineStart;

  return lines.slice(start, end).join('\n');
}

export async function getCommand(
  input: string,
  options: GetOptions
): Promise<void> {
  if (options.verbose) {
    setGlobalVerbose(true);
  }

  // Parse URL
  const parsed = parseGitHubFileUrl(input);
  if (!parsed) {
    console.error(chalk.red('Invalid GitHub file URL.'));
    console.error(chalk.dim('\nSupported formats:'));
    console.error(chalk.dim('  https://github.com/owner/repo/blob/branch/path/to/file'));
    console.error(chalk.dim('  https://github.com/owner/repo/blame/tag/path/to/file'));
    console.error(chalk.dim('  https://raw.githubusercontent.com/owner/repo/ref/path'));
    console.error(chalk.dim('  Any of the above with #L10 or #L10-L20 line references'));
    process.exit(1);
  }

  // Override ref if provided via option
  const ref = options.ref || parsed.ref;

  // Parse line range from --lines option if provided
  let lineStart = parsed.lineStart;
  let lineEnd = parsed.lineEnd;

  if (options.lines) {
    const lineMatch = options.lines.match(/^(\d+)(?:-(\d+))?$/);
    if (lineMatch) {
      lineStart = parseInt(lineMatch[1], 10);
      lineEnd = lineMatch[2] ? parseInt(lineMatch[2], 10) : undefined;
    } else {
      console.error(chalk.red('Invalid --lines format. Use: 10 or 10-20'));
      process.exit(1);
    }
  }

  verbose(options, `Parsed: ${parsed.owner}/${parsed.repo}/${parsed.path}@${ref}`);
  if (lineStart) {
    verbose(options, `Lines: ${lineStart}${lineEnd ? `-${lineEnd}` : ''}`);
  }

  try {
    // Fetch file content
    const file = await fetchFileContent(
      parsed.owner,
      parsed.repo,
      parsed.path,
      ref,
      options.raw ?? false
    );

    // Extract lines if specified
    const content = extractLines(file.content, lineStart, lineEnd);

    // Output
    if (options.clipboard) {
      await clipboardy.write(content);
      console.log(chalk.green(`✔ Copied ${file.path} to clipboard`));
      if (lineStart) {
        console.log(chalk.dim(`  Lines: ${lineStart}${lineEnd ? `-${lineEnd}` : ''}`));
      }
    } else if (options.output) {
      await Bun.write(options.output, content);
      console.log(chalk.green(`✔ Written to ${options.output}`));
    } else {
      // Output to stdout
      console.log(content);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

export function createGetCommand(): Command {
  const cmd = new Command('get')
    .description('Get file content from a GitHub URL')
    .argument('<url>', 'GitHub file URL (blob, blame, or raw)')
    .option('-r, --ref <ref>', 'Override branch/tag/commit ref')
    .option('-l, --lines <range>', 'Line range (e.g., 10 or 10-20)')
    .option('-o, --output <file>', 'Write to file')
    .option('-c, --clipboard', 'Copy to clipboard')
    .option('--raw', 'Fetch via raw.githubusercontent.com (faster, less metadata)')
    .option('-v, --verbose', 'Enable verbose logging')
    .addHelpText('after', `
Examples:
  # Get file from blob URL
  tools github get https://github.com/owner/repo/blob/main/package.json

  # Get specific lines
  tools github get https://github.com/owner/repo/blob/main/src/index.ts --lines 10-50

  # Get from blame URL (same content, different source)
  tools github get https://github.com/owner/repo/blame/v1.0.0/README.md

  # Get from raw URL
  tools github get https://raw.githubusercontent.com/owner/repo/main/data.json

  # Override ref to get different version
  tools github get https://github.com/owner/repo/blob/main/file.ts --ref v2.0.0

  # Copy to clipboard
  tools github get https://github.com/owner/repo/blob/main/file.ts -c

  # Use URL with line references
  tools github get "https://github.com/owner/repo/blob/main/file.ts#L10-L20"
`)
    .action(async (url, opts) => {
      try {
        await getCommand(url, opts);
      } catch (error) {
        logger.error({ error }, 'Get command failed');
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  return cmd;
}
