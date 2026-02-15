## How to Write More Tools

To create a new tool for GenesisTools, follow this guide:

### 1. Tool Structure

Create either:

-   A directory under `/src/your-tool-name/` with an `index.ts` or `index.tsx` file, OR
-   A single file `/src/your-tool-name.ts`

### 2. Basic Tool Template

```typescript
import { Command } from "commander";
import { input, select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import clipboardy from "clipboardy";
import logger from "../logger";

// Define your options interface
interface Options {
    input?: string;
    output?: string;
    verbose?: boolean;
}

const program = new Command();

program
    .name("your-tool-name")
    .description("Description of what your tool does")
    .argument("[input]", "Input file or directory")
    .option("-i, --input <path>", "Input file or directory")
    .option("-o, --output <path>", "Output destination")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (inputArg, options: Options) => {
        try {
            await main(inputArg, options);
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                process.exit(0);
            }
            throw error;
        }
    });

async function main(inputArg: string | undefined, options: Options) {
    // Get input - from args or interactive prompt
    let inputPath = options.input || inputArg;

    if (!inputPath) {
        inputPath = await input({
            message: "Enter input path:",
        });
    }

    // Your tool logic here
    // Example: Process the input
    const result = await processInput(inputPath);

    // Handle output
    if (options.output) {
        await Bun.write(options.output, result);
        logger.info(`✔ Output written to ${options.output}`);
    } else {
        // Interactive output selection
        const outputChoice = await select({
            message: "Where to output?",
            choices: [
                { value: "clipboard", name: "clipboard" },
                { value: "stdout", name: "stdout" },
                { value: "file", name: "file" },
            ],
        });

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
}

// Your processing function
async function processInput(inputPath: string): Promise<string> {
    // Implement your tool's core logic
    return `Processed: ${inputPath}`;
}

// Run the tool
program.parse();
```

### Choosing a Prompt Library

We support two prompt libraries. Choose based on your needs:

| Use Case | Library | Why |
|----------|---------|-----|
| **New tools** (preferred) | `@clack/prompts` | Beautiful UI, built-in spinners, structured logging |
| Multi-step wizards | `@clack/prompts` | `p.intro()`, `p.outro()`, `p.spinner()` for flow |
| Need `editor` prompt | `@inquirer/prompts` | No clack equivalent for multiline editor |
| Modifying existing tool | Keep current library | Don't mix libraries in same file |

**Full guide:** See `.claude/docs/prompts-and-colors.md` for comprehensive documentation.

### Alternative Template: @clack/prompts (Preferred for New Tools)

```typescript
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import clipboardy from "clipboardy";
import logger from "../logger";

interface Options {
    input?: string;
    output?: string;
    verbose?: boolean;
}

const program = new Command();

program
    .name("your-tool-name")
    .description("Description of what your tool does")
    .argument("[input]", "Input file or directory")
    .option("-i, --input <path>", "Input file or directory")
    .option("-o, --output <path>", "Output destination")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (inputArg, options: Options) => {
        await main(inputArg, options);
    });

async function main(inputArg: string | undefined, options: Options) {
    p.intro(pc.bgCyan(pc.black(" your-tool-name ")));

    // Get input - from args or interactive prompt
    let inputPath = options.input || inputArg;

    if (!inputPath) {
        const result = await p.text({
            message: "Enter input path:",
            placeholder: "/path/to/file",
        });

        if (p.isCancel(result)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
        inputPath = result;
    }

    // Spinner for async work
    const spinner = p.spinner();
    spinner.start("Processing...");
    const result = await processInput(inputPath);
    spinner.stop("Processing complete");

    // Handle output
    if (options.output) {
        await Bun.write(options.output, result);
        p.log.success(`Output written to ${options.output}`);
    } else {
        const outputChoice = await p.select({
            message: "Where to output?",
            options: [
                { value: "clipboard", label: "Clipboard" },
                { value: "stdout", label: "Console" },
                { value: "file", label: "File" },
            ],
        });

        if (p.isCancel(outputChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        switch (outputChoice) {
            case "clipboard":
                await clipboardy.write(result);
                p.log.success("Copied to clipboard!");
                break;
            case "stdout":
                console.log(result);
                break;
            case "file":
                // Prompt for filename...
                break;
        }
    }

    p.outro(pc.green("Done!"));
}

async function processInput(inputPath: string): Promise<string> {
    return `Processed: ${inputPath}`;
}

program.parse();
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

**Interactive Selection with Search**:

```typescript
import { search } from "@inquirer/prompts";

const selected = await search({
    message: "Select an item:",
    source: async (term) => {
        const filtered = items.filter((item) =>
            item.display.toLowerCase().includes((term || "").toLowerCase())
        );
        return filtered.map((item) => ({
            value: item.id,
            name: item.display,
        }));
    },
});
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

**Progress Indicators** (with @clack/prompts - preferred):

```typescript
import * as p from "@clack/prompts";

const spinner = p.spinner();
spinner.start("Processing...");
// Do work
spinner.stop("Done!"); // or spinner.stop(pc.red("Failed!"));
```

**Progress Indicators** (with ora - legacy):

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
