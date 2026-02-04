# GitHub Get Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `get` command to the GitHub CLI tool that fetches raw file content from any GitHub file URL

**Architecture:** Parse various GitHub URL formats (blob, blame, raw, etc.), extract owner/repo/path/ref, then fetch content via GitHub API (`/repos/{owner}/{repo}/contents/{path}?ref={ref}`) or raw.githubusercontent.com. Output to stdout, clipboard, or file.

**Tech Stack:** TypeScript, Commander.js, Octokit (existing), Bun runtime

---

## GitHub URL Formats to Support

The command must handle these URL patterns:

| URL Type | Example |
|----------|---------|
| Blob (branch) | `https://github.com/owner/repo/blob/main/path/to/file.ts` |
| Blob (tag) | `https://github.com/owner/repo/blob/v1.0.0/path/to/file.ts` |
| Blob (commit) | `https://github.com/owner/repo/blob/abc123/path/to/file.ts` |
| Blame (branch) | `https://github.com/owner/repo/blame/master/package.json` |
| Blame (tag) | `https://github.com/owner/repo/blame/v3.5.0/package.json` |
| Raw (branch) | `https://raw.githubusercontent.com/owner/repo/main/file.ts` |
| Raw (refs/heads) | `https://raw.githubusercontent.com/owner/repo/refs/heads/main/file.ts` |
| Raw (refs/tags) | `https://raw.githubusercontent.com/owner/repo/refs/tags/v1.0.0/file.ts` |
| With line numbers | `https://github.com/owner/repo/blob/main/file.ts#L10-L20` |

**All patterns decompose to:** `{ owner, repo, path, ref }`

---

## Task 1: Add URL Parser for File URLs

**Files:**
- Modify: `src/github/lib/url-parser.ts:15-58`
- Modify: `src/github/types.ts` (add new type)

**Step 1: Add GitHubFileUrl type to types.ts**

Add after line ~50 in types.ts:
```typescript
/**
 * Parsed GitHub file URL
 */
export interface GitHubFileUrl {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  lineStart?: number;
  lineEnd?: number;
}
```

**Step 2: Add parseGitHubFileUrl function to url-parser.ts**

Add at end of file:
```typescript
import type { GitHubFileUrl } from '../types';

/**
 * Parse a GitHub file URL into its components
 *
 * Supported formats:
 * - https://github.com/owner/repo/blob/ref/path/to/file
 * - https://github.com/owner/repo/blame/ref/path/to/file
 * - https://raw.githubusercontent.com/owner/repo/ref/path/to/file
 * - https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path
 * - https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path
 * - All above with optional #L10 or #L10-L20 line references
 */
export function parseGitHubFileUrl(input: string): GitHubFileUrl | null {
  // Extract line numbers if present (e.g., #L10 or #L10-L20)
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  const lineMatch = input.match(/#L(\d+)(?:-L(\d+))?$/);
  if (lineMatch) {
    lineStart = parseInt(lineMatch[1], 10);
    lineEnd = lineMatch[2] ? parseInt(lineMatch[2], 10) : undefined;
    input = input.replace(/#L\d+(?:-L\d+)?$/, '');
  }

  // Pattern 1: github.com blob/blame URLs
  // https://github.com/owner/repo/blob/ref/path/to/file
  // https://github.com/owner/repo/blame/ref/path/to/file
  const githubMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:blob|blame)\/([^/]+)\/(.+)/
  );
  if (githubMatch) {
    return {
      owner: githubMatch[1],
      repo: githubMatch[2],
      ref: githubMatch[3],
      path: githubMatch[4],
      lineStart,
      lineEnd,
    };
  }

  // Pattern 2: raw.githubusercontent.com with refs/heads or refs/tags
  // https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path
  // https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path
  const rawRefsMatch = input.match(
    /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/refs\/(heads|tags)\/([^/]+)\/(.+)/
  );
  if (rawRefsMatch) {
    return {
      owner: rawRefsMatch[1],
      repo: rawRefsMatch[2],
      ref: rawRefsMatch[4], // branch or tag name
      path: rawRefsMatch[5],
      lineStart,
      lineEnd,
    };
  }

  // Pattern 3: raw.githubusercontent.com simple format
  // https://raw.githubusercontent.com/owner/repo/ref/path/to/file
  const rawSimpleMatch = input.match(
    /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/
  );
  if (rawSimpleMatch) {
    return {
      owner: rawSimpleMatch[1],
      repo: rawSimpleMatch[2],
      ref: rawSimpleMatch[3],
      path: rawSimpleMatch[4],
      lineStart,
      lineEnd,
    };
  }

  return null;
}

/**
 * Build raw.githubusercontent.com URL from components
 */
export function buildRawGitHubUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}
```

**Step 3: Commit**

```bash
git add src/github/types.ts src/github/lib/url-parser.ts
git commit -m "feat(github): add file URL parser for blob/blame/raw URLs"
```

---

## Task 2: Create the Get Command

**Files:**
- Create: `src/github/commands/get.ts`

**Step 1: Create get.ts command file**

```typescript
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

/**
 * Format output with optional metadata header
 */
function formatOutput(file: FileContent, content: string, showHeader: boolean): string {
  if (!showHeader) {
    return content;
  }

  const lines = [
    `# ${file.path}`,
    `# URL: ${file.url}`,
    `# Ref: ${file.ref}`,
    file.sha ? `# SHA: ${file.sha}` : null,
    `# Size: ${file.size} bytes`,
    '',
    content,
  ].filter(Boolean);

  return lines.join('\n');
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
    let content = extractLines(file.content, lineStart, lineEnd);

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
```

**Step 2: Commit**

```bash
git add src/github/commands/get.ts
git commit -m "feat(github): add get command for fetching file content"
```

---

## Task 3: Register the Get Command

**Files:**
- Modify: `src/github/index.ts:7-29`

**Step 1: Add import for get command**

After line 11, add:
```typescript
import { createGetCommand, getCommand } from '@app/github/commands/get';
```

**Step 2: Register the command**

After line 29 (after `createCodeSearchCommand()`), add:
```typescript
program.addCommand(createGetCommand());
```

**Step 3: Add to interactive mode**

In the `interactiveMode` function, add a new choice. After line 89 (the 'search' choice), add:
```typescript
          { value: 'get', name: '📄 Get File Content' },
```

And add handler after the search action handling (around line 149), add:
```typescript
      if (action === 'get') {
        const fileUrl = await input({
          message: 'Enter GitHub file URL:',
        });

        if (!fileUrl.trim()) {
          console.log(chalk.yellow('No URL provided.'));
          continue;
        }

        const toClipboard = await confirm({
          message: 'Copy to clipboard?',
          default: false,
        });

        await getCommand(fileUrl, { clipboard: toClipboard });
        continue;
      }
```

**Step 4: Commit**

```bash
git add src/github/index.ts
git commit -m "feat(github): register get command in CLI"
```

---

## Task 4: Update the Skill Documentation

**Files:**
- Modify: `plugins/genesis-tools/skills/github/SKILL.md`

**Step 1: Add Get command section to Quick Reference table**

After the "Check auth status" row, add:
```markdown
| Get file content | `tools github get <file-url>` |
| Get specific lines | `tools github get <file-url> --lines 10-50` |
| Get file to clipboard | `tools github get <file-url> -c` |
```

**Step 2: Add new section after URL Parsing section**

After the "URL Parsing" section (around line 39), add:
```markdown
## Get File Content

Fetch raw file content from any GitHub file URL.

### Supported URL Formats
- `https://github.com/owner/repo/blob/branch/path/to/file`
- `https://github.com/owner/repo/blob/tag/path/to/file`
- `https://github.com/owner/repo/blob/commit/path/to/file`
- `https://github.com/owner/repo/blame/ref/path/to/file`
- `https://raw.githubusercontent.com/owner/repo/ref/path/to/file`
- `https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path`
- `https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path`
- All above with `#L10` or `#L10-L20` line references

### Examples
```bash
# Get file from blob URL
tools github get https://github.com/facebook/react/blob/main/package.json

# Get specific lines from a file
tools github get https://github.com/owner/repo/blob/main/src/index.ts --lines 10-50

# Get file from blame URL
tools github get https://github.com/owner/repo/blame/v1.0.0/README.md

# Get file from raw URL
tools github get https://raw.githubusercontent.com/owner/repo/main/data.json

# Override the ref to get a different version
tools github get https://github.com/owner/repo/blob/main/file.ts --ref v2.0.0

# Copy to clipboard instead of stdout
tools github get https://github.com/owner/repo/blob/main/file.ts -c

# URL with line references (quotes needed for shell)
tools github get "https://github.com/owner/repo/blob/main/file.ts#L10-L20"

# Faster fetch via raw URL (skips API, less metadata)
tools github get https://github.com/owner/repo/blob/main/file.ts --raw
```
```

**Step 3: Add Get Command section in CLI Options**

After the Search Command section (around line 226), add:
```markdown
### Get Command
```
tools github get <url> [options]

Options:
  -r, --ref <ref>         Override branch/tag/commit ref
  -l, --lines <range>     Line range (e.g., 10 or 10-20)
  -o, --output <file>     Write to file
  -c, --clipboard         Copy to clipboard
  --raw                   Fetch via raw.githubusercontent.com (faster)
  -v, --verbose           Enable verbose logging
```
```

**Step 4: Commit**

```bash
git add plugins/genesis-tools/skills/github/SKILL.md
git commit -m "docs(github): add get command documentation"
```

---

## Task 5: Test the Implementation

**Step 1: Test blob URL parsing**

```bash
tools github get https://github.com/grigorii-horos/cli-markdown/blob/master/package.json
```

Expected: File content output to stdout

**Step 2: Test blame URL parsing**

```bash
tools github get https://github.com/grigorii-horos/cli-markdown/blame/master/package.json
```

Expected: Same file content (blame URL converted correctly)

**Step 3: Test raw URL parsing**

```bash
tools github get https://raw.githubusercontent.com/grigorii-horos/cli-markdown/refs/heads/master/package.json
```

Expected: File content from raw URL

**Step 4: Test line extraction**

```bash
tools github get "https://github.com/grigorii-horos/cli-markdown/blob/master/package.json#L1-L5"
```

Expected: Only first 5 lines

**Step 5: Test clipboard output**

```bash
tools github get https://github.com/grigorii-horos/cli-markdown/blob/master/package.json -c
```

Expected: Content copied to clipboard, confirmation message

**Step 6: Test ref override**

```bash
tools github get https://github.com/facebook/react/blob/main/package.json --ref v18.2.0
```

Expected: package.json from v18.2.0 tag, not main

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add URL parser | `types.ts`, `url-parser.ts` |
| 2 | Create get command | `commands/get.ts` |
| 3 | Register command | `index.ts` |
| 4 | Update docs | `SKILL.md` |
| 5 | Test | Manual testing |
