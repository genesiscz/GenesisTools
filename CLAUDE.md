# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Running Tools

```bash
# List all available tools interactively
tools

# Run a specific tool
tools <tool-name> [args]

# Examples:
tools git-last-commits-diff . --commits 3 --clipboard
tools collect-files-for-ai ./my-repo -c 5
tools files-to-prompt src/ --cxml > prompt.xml
tools watch "src/**/*.ts" -v
tools npm-package-diff react 18.0.0 18.2.0
```

### Installation & Setup

```bash
# Initial setup (requires Bun)
bun install && ./install.sh
source ~/.zshrc  # or ~/.bashrc

# The install script adds GenesisTools to PATH by modifying shell config files
```

## Architecture Overview

GenesisTools is a TypeScript-based CLI toolkit that runs on Bun. The architecture follows a plugin pattern where each tool is self-contained:

### Core Structure

-   **Entry Point**: The `tools` executable is a TypeScript file with a shebang that:
    -   Without arguments: Shows an interactive tool selector using Enquirer
    -   With arguments: Executes the specified tool by running `bun run` on the appropriate file
-   **Tool Discovery**: Tools are discovered by checking `/src/` for:
    -   Directories containing `index.ts` or `index.tsx` (tool name = directory name)
    -   Standalone `.ts` or `.tsx` files (tool name = filename without extension)
-   **Execution Model**: Each tool runs in its own process via `bun run`, inheriting stdio for seamless interaction

### Key Components

-   **Logger** (`src/logger.ts`): Centralized logging using pino, outputs to `/logs/` directory organized by date
-   **MCP Integration**: Several tools implement Model Context Protocol servers for AI assistant integration
-   **No Build Step**: Bun executes TypeScript directly without compilation

### Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `minimist` for parsing command-line arguments with aliases
-   Define interfaces for `Options` and `Args` (extending Options with `_: string[]`)
-   Provide clear `--help` documentation with usage examples

**Interactive User Experience**:

-   Use `Enquirer` for interactive prompts when arguments are missing
-   Common prompt types: `autocomplete`, `select`, `input`
-   Handle user cancellation gracefully (catch errors with 'canceled' message)
-   Provide sensible defaults and suggestions in prompts

**Output Handling**:

-   Support multiple output destinations: file, clipboard, stdout
-   Use `clipboardy` for clipboard operations
-   Use `chalk` for colored terminal output (but strip ANSI codes for non-TTY)
-   Respect `--silent` and `--verbose` flags

**Process Execution**:

-   Use `Bun.spawn()` for executing external commands
-   Handle stdout/stderr streams properly using `new Response(proc.stdout).text()`
-   Always check exit codes and provide meaningful error messages

**File Operations**:

-   Use Node.js `path` module for cross-platform path handling
-   Resolve relative paths to absolute using `resolve()`
-   Check file/directory existence before operations
-   Use Bun's native file APIs (`Bun.write()`) for better performance

## How to Write More Tools

To create a new tool for GenesisTools, follow this guide:

### 1. Tool Structure

Create either:

-   A directory under `/src/your-tool-name/` with an `index.ts` or `index.tsx` file, OR
-   A single file `/src/your-tool-name.ts`

### 2. Basic Tool Template

```typescript
import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import clipboardy from "clipboardy";
import logger from "../logger";

// Define your options interface
interface Options {
    input?: string;
    output?: string;
    verbose?: boolean;
    help?: boolean;
    // Add your tool-specific options
}

interface Args extends Options {
    _: string[]; // Positional arguments
}

// Create Enquirer instance for interactive prompts
const prompter = new Enquirer();

// Show help message
function showHelp() {
    logger.info(`
Usage: tools your-tool-name [options] <arguments>

Description of what your tool does.

Arguments:
  <argument>      Description of required argument

Options:
  -i, --input     Input file or directory
  -o, --output    Output destination
  -v, --verbose   Enable verbose logging
  -h, --help      Show this help message

Examples:
  tools your-tool-name input.txt -o output.txt
  tools your-tool-name --verbose
`);
}

async function main() {
    // Parse command line arguments
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            i: "input",
            o: "output",
            v: "verbose",
            h: "help",
        },
        boolean: ["verbose", "help"],
        string: ["input", "output"],
    });

    // Show help if requested or no arguments
    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Get input - from args or interactive prompt
    let inputPath = argv.input || argv._[0];

    if (!inputPath) {
        try {
            const response = (await prompter.prompt({
                type: "input",
                name: "inputPath",
                message: "Enter input path:",
            })) as { inputPath: string };

            inputPath = response.inputPath;
        } catch (error: any) {
            if (error.message === "canceled") {
                logger.info("\nOperation cancelled by user.");
                process.exit(0);
            }
            throw error;
        }
    }

    // Your tool logic here
    try {
        // Example: Process the input
        const result = await processInput(inputPath);

        // Handle output
        if (argv.output) {
            await Bun.write(argv.output, result);
            logger.info(`✔ Output written to ${argv.output}`);
        } else {
            // Interactive output selection
            const { outputChoice } = (await prompter.prompt({
                type: "select",
                name: "outputChoice",
                message: "Where to output?",
                choices: ["clipboard", "stdout", "file"],
            })) as { outputChoice: string };

            switch (outputChoice) {
                case "clipboard":
                    await clipboardy.write(result);
                    logger.info("✔ Copied to clipboard!");
                    break;
                case "stdout":
                    console.log(result);
                    break;
                case "file":
                    // Prompt for filename...
                    break;
            }
        }
    } catch (error) {
        logger.error(`✖ Error: ${error}`);
        process.exit(1);
    }
}

// Your processing function
async function processInput(input: string): Promise<string> {
    // Implement your tool's core logic
    return `Processed: ${input}`;
}

// Run the tool
main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
```

### 3. Common Patterns to Follow

**Using Bun.spawn for External Commands**:

```typescript
const proc = Bun.spawn({
    cmd: ["git", "status"],
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
});

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
    logger.error(`Command failed: ${stderr}`);
}
```

**Interactive Selection with Autocomplete**:

```typescript
const choices = items.map((item) => ({
    name: item.id, // Value returned
    message: item.display, // Shown to user
}));

const { selected } = (await prompter.prompt({
    type: "autocomplete",
    name: "selected",
    message: "Select an item:",
    choices: choices,
    limit: 10, // Show 10 at a time
})) as { selected: string };
```

**File Watching with Chokidar**:

```typescript
import chokidar from "chokidar";

const watcher = chokidar.watch(pattern, {
    persistent: true,
    ignoreInitial: false,
});

watcher.on("change", (path) => {
    logger.info(`File changed: ${path}`);
});
```

**Progress Indicators**:

```typescript
import ora from "ora";

const spinner = ora("Processing...").start();
// Do work
spinner.succeed("Done!");
// or spinner.fail("Failed!");
```

### 4. Best Practices

1. **Always provide a help message** with clear usage examples
2. **Support both CLI args and interactive mode** for better UX
3. **Use the centralized logger** instead of console.log
4. **Handle errors gracefully** with meaningful messages
5. **Support common output options**: file, clipboard, stdout
6. **Use TypeScript interfaces** for type safety
7. **Respect TTY vs non-TTY** environments (strip colors for pipes)
8. **Add verbose/debug modes** for troubleshooting
9. **Use meaningful exit codes** (0 for success, 1+ for errors)
10. **Test with various input scenarios** including edge cases

### 5. Testing Your Tool

```bash
# Test directly
bun run src/your-tool-name/index.ts --help

# Test through the tools command
tools your-tool-name --help

# Test with different inputs
tools your-tool-name test.txt -o output.txt
echo "input" | tools your-tool-name
```

## Important Notes

-   **Runtime**: This project requires Bun as it uses Bun-specific APIs (e.g., `Bun.spawn`)
-   **Global Access**: The `install.sh` script modifies shell config to add GenesisTools to PATH
-   **No Tests**: The project currently has no test suite
-   **TypeScript Config**: Strict mode enabled, ES modules, no emit (Bun runs TS directly)
-   **Logging**: Check `/logs/` directory for debug information if tools encounter errors
