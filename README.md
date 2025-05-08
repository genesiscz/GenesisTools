# GenesisTools

GenesisTools is a collection of utilities designed to simplify various development tasks such as Git operations, file collection for AI analysis, generating GitHub release notes, computing message lengths, and watching files for changes. All tools are built with TypeScript and run on BunJS.

## Installation

We expect you to have `bun` installed because there are some tools that use Bun API available only on BunJS environment. 

To install project dependencies and make `tools` command available everywhere, run 

```
bun install && ./install.sh
```

After that, run `source ~/.zshrc` if you use `zsh` or `source ~/.bashrc` if you use `bash`

## Tools Overview

The project includes the following tools:

### 0. List of tools available

You can just run 

```bash
tools
```

Which will give you list of all tools available. If you pick one from the list, it will automatically save the command to the clipboard.

### 1. Git Last Commits Diff

This tool displays the differences between the last few commits (or staged/untsaged/all changes) in a Git repository. Can be handy for AI input.

**Usage:**

```
tools git-last-commits-diff <directory> [--commits X] [--output FILE] [--help]
```

**Options:**

-   `<directory>`: Required. Path to the Git repository.
-   `--commits` (or `-c`): Number of recent commits to diff (e.g., `--commits 5` to diff `HEAD~5..HEAD`). If omitted, the tool will fetch the last 200 commits and present an interactive autocomplete list, allowing you to select a specific commit to diff against `HEAD`.
-   `--output` (or `-o`): Write the diff output to a file. If not provided, the output is printed to stdout.
-   `--help` (or `-h`): Show the usage help message.

**Example:**

```
tools git-last-commits-diff /path/to/repo --commits 2
```

### 2. Collect Files for AI

This tool is designed to collect and aggregate files from your project for analysis by AI systems. It can be configured to filter files by staged, unstaged, both OR files changed in the last X commits.

**Usage:**

```
tools collect-files-for-ai [options]
```

```
Usage: collect-uncommitted-files <directory> [options]

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
  tools collect-files-for-ai ./my-repo -c 5
  tools collect-files-for-ai ../other-repo --staged --target ./collected_staged
  tools collect-files-for-ai /path/to/project --all
```

### 3. GitHub Release Notes

This tool assists in generating release notes by parsing commit histories and formatting them appropriately for GitHub releases.

**Usage:**

```
tools github-release-notes <owner>/<repo>|<github-url> <output-file> [options]
```

```
Usage: tools github-release-notes <owner>/<repo>|<github-url> <output-file> [options]

Arguments:
  owner/repo     GitHub repository in format "owner/repo" or full github.com URL
  output-file    Path to the output markdown file

Options:
  --limit=<n>    Limit the number of releases to fetch
  --oldest       Sort releases from oldest to newest (default is newest to oldest)
  -h, --help     Show this help message

Example:
  tools github-release-notes software-mansion/react-native-reanimated releases.md --limit=10
  tools github-release-notes https://github.com/software-mansion/react-native-reanimated releases.md
  tools github-release-notes software-mansion/react-native-reanimated releases.md --oldest

Note:
  To avoid GitHub API rate limits, you can set the GITHUB_TOKEN environment variable.
  export GITHUB_TOKEN=your_github_token
```

### 4. T3Chat Length

This tool is internal and probably not useful to you

To use, modify the `myInputJson` variable in `src/t3chat-length/index.ts` and run:

```
tools t3chat-length
```

### 5. Watchman

This tool monitors WatchMan watched files for changes and can trigger actions when changes are detected. It is useful for development workflows where automatic recompilation or testing is required.

**Usage:**

This tool uses Watchman to monitor a directory for file changes and prints a message when files are modified. You can specify the directory to watch as a positional argument, use `-c` or `--current` to watch the current directory, or select interactively if no argument is provided.

**Options:**

-   `<directory>`: Path to the directory to watch (optional, can be relative or absolute).
-   `-c`, `--current`: Watch the current working directory.

**Example:**

```
tools watchman -c
tools watchman /path/to/dir
```

If no argument is provided, you will be prompted to select a directory interactively.

## Running the Tools

All tools are designed to be executed using BunJS. For example, to run any tool, use:

```
tools <tool-folder> [options]
```

where `<tool-folder>` is one of:

-   `git-last-commits-diff`
-   `collect-files-for-ai`
-   `files-to-prompt`
-   `github-release-notes`
-   `t3chat-length`
-   `watchman`
-   `watch`

Refer to each tool's section above for specific usage and options.

### 6. Watch (formerly Watch-Glob)

A command-line tool that watches files matching a glob pattern and displays changes in real-time, similar to `tail -f` but for multiple files including those created after the watch has started.

**Features:**

- Watch files matching any glob pattern (e.g., `~/projects/**/*.{js,ts,tsx}`)
- Display file content in real-time as files are created or modified
- Automatically detect new files that match the pattern
- Show file additions, modifications, and removals
- Support for tilde expansion (`~`) for home directory
- Configurable polling interval
- Follow mode to tail files continuously
- Shows a summary of scanned directories and matched files

**Usage:**

```bash
tools watch [glob-pattern] [options]
```

**Options:**

- `--seconds`, `-s`: Polling interval in seconds (default: 3)
- `--verbose`, `-v`: Enable verbose logging to see more detailed information about which files are being scanned
- `--follow`, `-f`: Follow mode that only shows new content (like tail -f)
- `--lines`, `-n`: Number of lines to display from each file (default: 50)
- `--help`, `-h`: Show help information

**Examples:**

Watch all TypeScript files in the `src` directory and its subdirectories:
```bash
tools watch "src/**/*.ts"
```

Watch multiple file types in your home directory with verbose logging:
```bash
tools watch "~/projects/**/*.{js,ts,tsx}" -v -n 100
```

Only show new changes to files (follow mode):
```bash
tools watch "src/**/*.ts" -f
```

Use a faster polling interval (1 second) with follow mode:
```bash
tools watch "src/**/*.ts" --seconds 1 -f
```

**How It Works:**

The tool uses the `chokidar` library to watch for file changes based on the provided glob pattern. When files are added, modified, or removed, it displays the changes in the terminal in real-time.

- New or modified files: The tool shows the timestamp, file path, and the new content of the file
- Removed files: The tool shows a notification that the file has been removed
- Scanned directories: The tool shows a list of all directories being scanned
- Matched files: The tool shows a list of all files that match the pattern

The tool can be stopped by pressing `Ctrl+C`.

### 7. Files to Prompt

This tool converts files to a prompt format suitable for AI systems. It can process individual files or recursively process directories, with options for various output formats and filtering.

**Usage:**

```
tools files-to-prompt [options] [paths...]
```

**Options:**

-   `-e`, `--extension EXT`: File extensions to include (can use multiple times)
-   `--include-hidden`: Include files and folders starting with `.`
-   `--ignore-files-only`: `--ignore` option only ignores files
-   `--ignore-gitignore`: Ignore .gitignore files and include all files
-   `--ignore PATTERN`: List of patterns to ignore (can use multiple times)
-   `-o`, `--output FILE`: Output to a file instead of stdout
-   `-c`, `--cxml`: Output in XML-ish format suitable for Claude
-   `-m`, `--markdown`: Output Markdown with fenced code blocks
-   `-n`, `--line-numbers`: Add line numbers to the output
-   `-0`, `--null`: Use NUL character as separator when reading from stdin
-   `-h`, `--help`: Show this help message
-   `--version`: Show version information

**Examples:**

```
tools files-to-prompt src/components
tools files-to-prompt -e js -e ts src/
tools files-to-prompt --markdown -o output.md project/
find . -name "*.py" | tools files-to-prompt -0
```

## License

This project is licensed under the MIT License.


## Useful notes

### MCP 
To add a bunch of MCP servers installed, it's best to install them globally like 

```bash
bun add --global @modelcontextprotocol/inspector @modelcontextprotocol/server-sequential-thinking @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-github @modelcontextprotocol/server-puppeteer @modelcontextprotocol/server-brave-search @executeautomation/playwright-mcp-server
```

### MCP Configuration for Cursor

My own configuration of mcp.json for Cursor

```
{
  "mcpServers": {
    "github": {
      "command": "mcp-server-github",
      "args": [],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_..."
      }
    },
    "sequential-thinking": {
      "command": "mcp-server-sequential-thinking",
      "args": [],
      "env": {}
    },
    "puppeteer": {
      "command": "mcp-server-puppeteer",
      "args": [],
      "env": {}
    },
    "playwright": {
      "command": "playwright-mcp-server",
      "args": [],
      "env": {}
    },
    "brave-search": {
      "command": "mcp-server-brave-search",
      "env": {
        "BRAVE_API_KEY": "...."
      }
    },
    "filesystem": {
      "command": "mcp-server-filesystem",
      "args": [
        "/Users/Martin/Allowed/Directory/"
      ]
    }
  }
}
```