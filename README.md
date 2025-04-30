# GenesisTools

GenesisTools is a collection of utilities designed to simplify various development tasks such as Git operations, file collection for AI analysis, generating GitHub release notes, computing message lengths, and watching files for changes. All tools are built with TypeScript and run on BunJS.

## Installation

To install the project dependencies, use Bun:

```
bun install
```

## Tools Overview

The project includes the following tools:

### 1. Git Last Commits Diff

This tool displays the differences between the last few commits in a Git repository.

**Usage:**

```
tools git-last-commits-diff <directory> [--commits X] [--output FILE] [--help]
```

**Options:**

-   `<directory>`: Required. Path to the Git repository.
-   `--commits` (or `-c`): Number of commits to diff. If omitted, the tool will prompt for a number.
-   `--output` (or `-o`): Write the diff output to a file. If not provided, the output is printed to stdout.
-   `--help` (or `-h`): Show the usage help message.

**Example:**

```
tools git-last-commits-diff /path/to/repo --commits 2
```

### 2. Collect Files for AI

This tool is designed to collect and aggregate files from your project for analysis by AI systems. It can be configured to filter files by type, size, or directory structures to suit your analysis needs.

**Usage:**

```
tools collect-files-for-ai [options]
```

```
Usage: collect-uncommitted-files.ts <directory> [options]

Arguments:
  <directory>         Required. Path to the Git repository.

Options:
  Mode (choose one, default is --all if --commits is not used):
    -c, --commits NUM   Collect files changed in the last NUM commits.
    -s, --staged        Collect only staged files.
    -u, --unstaged      Collect only unstaged files.
    -a, --all           Collect all uncommitted (staged + unstaged) files.

  Output:
    -t, --target DIR    Directory to copy files into (default: ./.ai/YYYY-MM-DD-HH.mm).
    -h, --help          Show this message.

Examples:
  bun run src/git/collect-uncommitted-files.ts ./my-repo -c 5
  bun run src/git/collect-uncommitted-files.ts ../other-repo --staged --target ./collected_staged
  bun run src/git/collect-uncommitted-files.ts /path/to/project --all
```

### 3. GitHub Release Notes

This tool assists in generating release notes by parsing commit histories and formatting them appropriately for GitHub releases.

**Usage:**

```
tools github-release-notes <owner>/<repo>|<github-url> <output-file> [options]
```

```
Usage: bun src/github-release-notes/index.ts <owner>/<repo>|<github-url> <output-file> [options]

Arguments:
  owner/repo     GitHub repository in format "owner/repo" or full github.com URL
  output-file    Path to the output markdown file

Options:
  --limit=<n>    Limit the number of releases to fetch
  --oldest       Sort releases from oldest to newest (default is newest to oldest)
  -h, --help     Show this help message

Example:
  bun src/github-release-notes/index.ts software-mansion/react-native-reanimated releases.md --limit=10
  bun src/github-release-notes/index.ts https://github.com/software-mansion/react-native-reanimated releases.md
  bun src/github-release-notes/index.ts software-mansion/react-native-reanimated releases.md --oldest

Note:
  To avoid GitHub API rate limits, you can set the GITHUB_TOKEN environment variable.
  export GITHUB_TOKEN=your_github_token
```

### 4. T3Chat Length

This tool is internal and probably not useful to you

To use, modify the `myInputJson` variable in `src/t3chat-length/index.ts` and run:

```
bun run src/t3chat-length/index.ts
```

### 5. Watch

This tool monitors WatchMan watched files for changes and can trigger actions when changes are detected. It is useful for development workflows where automatic recompilation or testing is required.

**Usage:**

This tool uses Watchman to monitor a directory for file changes and prints a message when files are modified. You can specify the directory to watch as a positional argument, use `-c` or `--current` to watch the current directory, or select interactively if no argument is provided.

**Options:**

-   `<directory>`: Path to the directory to watch (optional, can be relative or absolute).
-   `-c`, `--current`: Watch the current working directory.

**Example:**

```
bun run src/watch/index.ts -c
bun run src/watch/index.ts /path/to/dir
```

If no argument is provided, you will be prompted to select a directory interactively.

## Running the Tools

All tools are designed to be executed using BunJS. For example, to run any tool, use:

```
bun run src/<tool-folder>/index.ts [options]
```

where `<tool-folder>` is one of:

-   `git-last-commits-diff`
-   `collect-files-for-ai`
-   `github-release-notes`
-   `t3chat-length`
-   `watch`

Refer to each tool's section above for specific usage and options.

## License

This project is licensed under the MIT License.
