# Tools Browser & Markdown-CLI Enhancement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Revamp the `tools` CLI entry point with fuzzy matching, clean errors, and an interactive @clack/prompts browser with search, README preview, and Commander introspection. Enhance `markdown-cli` with --watch, --width, --theme flags.

**Architecture:** Modular approach — `src/tools/` becomes a new tool for the interactive browser. Entry point (`tools` file) stays thin (routing + fuzzy match). Shared utilities in `src/tools/lib/` for discovery, introspection, and preview. Markdown engine gains an options object for width/theme/color.

**Tech Stack:** @clack/prompts, picocolors, markdown-it + cli-html (existing), chokidar (existing), Commander (existing)

**Branch:** `feat/tools-index-markdown`

---

### Task 1: Create branch and scaffold directory

**Files:**
- Create: `src/tools/index.ts` (empty placeholder)
- Create: `src/tools/lib/` directory

**Step 1: Create branch from current HEAD**

```bash
git checkout -b feat/tools-index-markdown --no-track
```

**Step 2: Create directory structure**

```bash
mkdir -p src/tools/lib
```

**Step 3: Create placeholder files**

Create `src/tools/index.ts`:
```ts
#!/usr/bin/env bun
// Interactive tool browser — implemented in subsequent tasks
console.log("tools browser placeholder");
```

**Step 4: Commit**

```bash
git add src/tools/index.ts
git commit -m "chore: scaffold src/tools/ directory for interactive browser"
```

---

### Task 2: Fix entry point error formatting

**Files:**
- Modify: `tools` (lines 119-129)

The current error format outputs 5+ separate `logger.error()` calls, each prefixed with `ERROR:`. Replace with a single clean chalk-formatted message.

**Step 1: Replace the error block in `executeTool()`**

In the `tools` file, replace the "not found" error block (lines 119-129) with:

```ts
if (!targetScript) {
    const chalk = (await import("chalk")).default;
    console.error(
        `\n  ${chalk.red("Tool not found:")} ${chalk.bold(scriptId)}\n` +
        `  Looked in: ${chalk.dim(srcDir)}\n`
    );
    process.exit(1);
}
```

This gives a clean 2-line error instead of 5+ lines.

**Step 2: Verify the fix**

```bash
bun run tools nonexistent-tool-abc 2>&1
```

Expected: Clean 2-line error, no `ERROR:` prefix spam.

**Step 3: Commit**

```bash
git add tools
git commit -m "fix: clean up tool-not-found error formatting"
```

---

### Task 3: Add fuzzy matching to entry point

**Files:**
- Modify: `tools` (the `executeTool` function and imports)

When a tool name doesn't match exactly, fuzzy-filter available tools and either:
- Show suggestions in the error message
- Launch an interactive selector pre-filtered

**Step 1: Add fuzzy matching logic**

After the "not found" check in `executeTool()`, before `process.exit(1)`, add fuzzy matching:

```ts
if (!targetScript) {
    // Fuzzy match: find tools that start with or contain the input
    const availableTools = await getAvailableTools(srcDir);
    const matches = availableTools.filter(t =>
        t.toLowerCase().includes(scriptId.toLowerCase())
    );

    const chalk = (await import("chalk")).default;

    if (matches.length === 0) {
        console.error(
            `\n  ${chalk.red("Tool not found:")} ${chalk.bold(scriptId)}\n` +
            `  Looked in: ${chalk.dim(srcDir)}\n`
        );
        process.exit(1);
    }

    // Launch interactive selector pre-filtered
    const { search } = await import("@inquirer/prompts");
    const { ExitPromptError } = await import("@inquirer/core");

    console.log(`\n  ${chalk.yellow("No exact match for")} ${chalk.bold(scriptId)}${chalk.yellow(". Did you mean?")}\n`);

    try {
        const tool = await search({
            message: "Select a tool:",
            source: async (term) => {
                const filtered = matches.filter(t =>
                    t.toLowerCase().includes((term || "").toLowerCase())
                );
                return filtered.map(t => ({ value: t, name: t }));
            },
        });

        // Re-execute with the selected tool
        const newArgs = [tool, ...scriptArgs];
        executeTool(newArgs[0], newArgs.slice(1));
    } catch (error) {
        if (error instanceof ExitPromptError) {
            process.exit(0);
        }
        throw error;
    }
    return;
}
```

Note: `executeTool` needs to become async. Update its signature:
```ts
async function executeTool(scriptId, scriptArgs) {
```

And update the call in `main()`:
```ts
await executeTool(scriptId, scriptArgs);
```

**Step 2: Test fuzzy matching**

```bash
bun run tools cli- 2>&1
```

Expected: Shows "No exact match for cli-. Did you mean?" with `markdown-cli` in the selector.

```bash
bun run tools git 2>&1
```

Expected: Shows all git-related tools (git-commit, git-last-commits-diff, git-rebase-multiple, etc.)

**Step 3: Commit**

```bash
git add tools
git commit -m "feat: add fuzzy matching when tool name doesn't match exactly"
```

---

### Task 4: Create tool discovery module

**Files:**
- Create: `src/tools/lib/discovery.ts`

This module scans `src/` for tools and extracts descriptions from multiple sources (priority: Commander description > README first line > humanized name).

**Step 1: Implement discovery module**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const INDEX_FILE_NAMES = ["index.ts", "index.tsx"];
const SCRIPT_EXTENSIONS = [".ts", ".tsx"];

export interface ToolInfo {
    name: string;
    description: string;
    hasReadme: boolean;
    path: string; // path to the entry script
}

/**
 * Scan src/ directory and discover all available tools.
 */
export function discoverTools(srcDir: string): ToolInfo[] {
    const tools: ToolInfo[] = [];

    const entries = readdirSync(srcDir);
    for (const entry of entries) {
        const entryPath = join(srcDir, entry);
        try {
            const stats = statSync(entryPath);
            if (stats.isDirectory()) {
                const indexFile = INDEX_FILE_NAMES.find(f => existsSync(join(entryPath, f)));
                if (indexFile) {
                    tools.push({
                        name: entry,
                        description: extractDescription(entryPath, entry),
                        hasReadme: existsSync(join(entryPath, "README.md")),
                        path: join(entryPath, indexFile),
                    });
                }
            } else if (
                stats.isFile() &&
                SCRIPT_EXTENSIONS.some(ext => entry.endsWith(ext)) &&
                !INDEX_FILE_NAMES.includes(entry)
            ) {
                const ext = SCRIPT_EXTENSIONS.find(e => entry.endsWith(e))!;
                const name = basename(entry, ext);
                tools.push({
                    name,
                    description: extractDescription(join(srcDir, name), name),
                    hasReadme: existsSync(join(srcDir, name, "README.md")),
                    path: entryPath,
                });
            }
        } catch {
            // skip entries with errors
        }
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract description from README.md first meaningful line.
 * Falls back to humanized name.
 */
function extractDescription(toolDir: string, toolName: string): string {
    // Try README.md first line (after title)
    const readmePath = join(toolDir, "README.md");
    if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines, headings, badges, horizontal rules
            if (!trimmed) continue;
            if (trimmed.startsWith("#")) continue;
            if (trimmed.startsWith("---")) continue;
            if (trimmed.startsWith("![")) continue;
            if (trimmed.startsWith("[![")) continue;
            // Found a description line
            return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
        }
    }

    // Fallback: humanize the tool name
    return toolName
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Get the README content for a tool, or null if not available.
 */
export function getReadme(srcDir: string, toolName: string): string | null {
    const readmePath = join(srcDir, toolName, "README.md");
    if (existsSync(readmePath)) {
        return readFileSync(readmePath, "utf-8");
    }
    return null;
}
```

**Step 2: Verify it compiles**

```bash
bunx tsgo --noEmit 2>&1 | grep "tools/lib/discovery"
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tools/lib/discovery.ts
git commit -m "feat(tools): add tool discovery module with description extraction"
```

---

### Task 5: Create Commander introspection module

**Files:**
- Create: `src/tools/lib/introspect.ts`

Runs `bun run <tool> --help` and parses the output to extract commands, options, and descriptions.

**Step 1: Implement introspection module**

```ts
import { spawnSync } from "node:child_process";

export interface CommandOption {
    flags: string;      // e.g. "-o, --output <path>"
    description: string;
}

export interface SubCommand {
    name: string;
    description: string;
    options?: CommandOption[];
}

export interface ToolHelp {
    name: string;
    description: string;
    usage: string;
    commands: SubCommand[];
    options: CommandOption[];
}

/**
 * Run `bun run <scriptPath> --help` and parse the Commander output.
 */
export function introspectTool(scriptPath: string): ToolHelp | null {
    const result = spawnSync("bun", ["run", scriptPath, "--help"], {
        timeout: 5000,
        encoding: "utf-8",
    });

    const output = result.stdout || result.stderr || "";
    if (!output.trim()) return null;

    return parseHelpOutput(output);
}

/**
 * Parse Commander-style --help output into structured data.
 *
 * Typical format:
 *   Usage: tool-name [options] [command]
 *
 *   Description text
 *
 *   Options:
 *     -h, --help       display help for command
 *     -v, --verbose    verbose output
 *
 *   Commands:
 *     subcommand [opts]  description
 *     help [command]     display help for command
 */
function parseHelpOutput(output: string): ToolHelp {
    const lines = output.split("\n");
    const help: ToolHelp = {
        name: "",
        description: "",
        usage: "",
        commands: [],
        options: [],
    };

    let section: "none" | "options" | "commands" | "description" = "none";

    for (const line of lines) {
        const trimmed = line.trim();

        // Usage line
        if (trimmed.startsWith("Usage:")) {
            help.usage = trimmed.replace("Usage:", "").trim();
            const parts = help.usage.split(/\s+/);
            if (parts[0]) help.name = parts[0];
            section = "description";
            continue;
        }

        // Section headers
        if (trimmed === "Options:" || trimmed === "Options") {
            section = "options";
            continue;
        }
        if (trimmed === "Commands:" || trimmed === "Commands") {
            section = "commands";
            continue;
        }

        // Empty line resets description section
        if (!trimmed && section === "description") {
            continue;
        }

        // Parse content based on section
        if (section === "description" && trimmed && !help.description) {
            help.description = trimmed;
            continue;
        }

        if (section === "options" && trimmed) {
            const match = trimmed.match(/^(-\S+(?:,\s*-\S+)*(?:\s+<\S+>)?(?:\s+\[\S+\])?)\s{2,}(.+)/);
            if (match) {
                help.options.push({
                    flags: match[1].trim(),
                    description: match[2].trim(),
                });
            }
            continue;
        }

        if (section === "commands" && trimmed) {
            const match = trimmed.match(/^(\S+(?:\s+\[?\S+\]?)*)\s{2,}(.+)/);
            if (match) {
                help.commands.push({
                    name: match[1].trim(),
                    description: match[2].trim(),
                });
            }
            continue;
        }
    }

    return help;
}

/**
 * Run --help on a specific subcommand.
 */
export function introspectSubcommand(scriptPath: string, subcommand: string): ToolHelp | null {
    const result = spawnSync("bun", ["run", scriptPath, subcommand, "--help"], {
        timeout: 5000,
        encoding: "utf-8",
    });

    const output = result.stdout || result.stderr || "";
    if (!output.trim()) return null;

    return parseHelpOutput(output);
}
```

**Step 2: Verify it compiles**

```bash
bunx tsgo --noEmit 2>&1 | grep "tools/lib/introspect"
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tools/lib/introspect.ts
git commit -m "feat(tools): add Commander introspection module for --help parsing"
```

---

### Task 6: Create search-select prompt component

**Files:**
- Create: `src/utils/prompts/clack/search-select.ts`
- Modify: `src/utils/prompts/clack/index.ts` (add re-export)

A single-select version of the existing `searchMultiselect` in `src/utils/prompts/clack/search-multiselect.ts`. When the user hovers over an item, a `onHighlight` callback fires (used by the browser to show README preview).

**Step 1: Implement search-select**

Base this on the existing `searchMultiselect` pattern (same keypress handling, same styling symbols). Key differences:
- Single select: Enter confirms the highlighted item (no space toggle)
- Add `onHighlight?: (item: SearchItem<T>) => void` callback
- Add `hint` per-item support (already in SearchItem type)

The component should:
- Show a search input at top
- Filter items as user types
- Up/down to navigate
- Enter to select
- Escape to cancel
- Call `onHighlight` when cursor moves (debounced ~100ms)

Model it closely on `src/utils/prompts/clack/search-multiselect.ts` (lines 46-251), replacing multi-select logic with single-select.

**Step 2: Re-export from clack index**

Add to `src/utils/prompts/clack/index.ts`:
```ts
export * from "./search-select";
```

**Step 3: Verify compilation**

```bash
bunx tsgo --noEmit 2>&1 | grep "search-select"
```

**Step 4: Commit**

```bash
git add src/utils/prompts/clack/search-select.ts src/utils/prompts/clack/index.ts
git commit -m "feat(prompts): add searchSelect single-select with onHighlight callback"
```

---

### Task 7: Build the interactive browser

**Files:**
- Modify: `src/tools/index.ts` (replace placeholder)

This is the main interactive browser. Flow:

1. `@clack/prompts` intro with ASCII logo
2. Discover tools via `discovery.ts`
3. Show searchable list with descriptions (using `searchSelect`)
4. On highlight → show tool description/README snippet below
5. On select → offer options: "Run", "View README", "Explore subcommands", "Copy command"
6. "View README" → render full README via `renderMarkdownToCli()`, pipe through pager
7. "Explore subcommands" → introspect via `introspect.ts`, show subcommand picker
8. "Copy command" → copy `tools <name>` to clipboard

**Step 1: Implement the interactive browser**

```ts
#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import clipboardy from "clipboardy";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { discoverTools, getReadme } from "./lib/discovery.js";
import { introspectTool } from "./lib/introspect.js";
import { renderMarkdownToCli } from "../utils/markdown/index.js";
import { searchSelect } from "../utils/prompts/clack/search-select.js";

const LOGO = `
 ██████╗ ████████╗
██╔════╝ ╚══██╔══╝
██║  ███╗   ██║
██║   ██║   ██║
╚██████╔╝   ██║
 ╚═════╝    ╚═╝
`;

async function main() {
    const workspaceRoot = resolve(import.meta.dirname, "..");
    const srcDir = join(workspaceRoot);

    p.intro(pc.bgCyan(pc.black(" GenesisTools ")));
    console.log(pc.cyan(LOGO));

    const tools = discoverTools(srcDir);

    if (tools.length === 0) {
        p.log.warn("No tools found in src/");
        process.exit(0);
    }

    p.log.info(`${pc.bold(String(tools.length))} tools available`);

    // Main loop — keep browsing until user exits
    while (true) {
        const selected = await searchSelect({
            message: "Search tools:",
            items: tools.map(t => ({
                value: t.name,
                label: t.name,
                hint: t.description,
            })),
            maxVisible: 12,
        });

        if (p.isCancel(selected) || selected === undefined) {
            p.outro(pc.dim("Bye!"));
            break;
        }

        const tool = tools.find(t => t.name === selected)!;
        await handleToolAction(tool, srcDir);
    }
}

async function handleToolAction(tool: ReturnType<typeof discoverTools>[0], srcDir: string) {
    const action = await p.select({
        message: `${pc.bold(tool.name)} — what do you want to do?`,
        options: [
            { value: "run", label: "Run", hint: `tools ${tool.name}` },
            ...(tool.hasReadme ? [{ value: "readme", label: "View README" }] : []),
            { value: "help", label: "Explore subcommands", hint: "--help" },
            { value: "copy", label: "Copy command to clipboard" },
            { value: "back", label: "Back to list" },
        ],
    });

    if (p.isCancel(action) || action === "back") return;

    if (action === "run") {
        p.outro(`Running ${pc.bold(`tools ${tool.name}`)}...`);
        spawnSync("bun", ["run", tool.path], { stdio: "inherit", cwd: process.cwd() });
        process.exit(0);
    }

    if (action === "readme") {
        const readme = getReadme(srcDir, tool.name);
        if (readme) {
            console.log(renderMarkdownToCli(readme));
        } else {
            p.log.warn("No README.md found for this tool.");
        }
        // After viewing, show action menu again
        await handleToolAction(tool, srcDir);
        return;
    }

    if (action === "help") {
        const help = introspectTool(tool.path);
        if (!help || (help.commands.length === 0 && help.options.length === 0)) {
            p.log.warn("No subcommands or options found.");
            await handleToolAction(tool, srcDir);
            return;
        }

        // Show subcommands if available
        if (help.commands.length > 0) {
            const cmd = await p.select({
                message: `${pc.bold(tool.name)} subcommands:`,
                options: [
                    ...help.commands.map(c => ({
                        value: c.name,
                        label: c.name,
                        hint: c.description,
                    })),
                    { value: "__back__", label: "Back" },
                ],
            });

            if (!p.isCancel(cmd) && cmd !== "__back__") {
                const command = `tools ${tool.name} ${cmd}`;
                await clipboardy.write(command);
                p.log.success(`Copied: ${pc.bold(command)}`);
            }
        }

        // Show options
        if (help.options.length > 0) {
            p.log.info(pc.bold("Options:"));
            for (const opt of help.options) {
                console.log(`  ${pc.cyan(opt.flags)}  ${pc.dim(opt.description)}`);
            }
            console.log();
        }

        await handleToolAction(tool, srcDir);
        return;
    }

    if (action === "copy") {
        const command = `tools ${tool.name}`;
        await clipboardy.write(command);
        p.log.success(`Copied: ${pc.bold(command)}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
```

**Step 2: Test the browser**

```bash
bun run src/tools/index.ts
```

Expected: Shows logo, tool count, searchable list with descriptions.

**Step 3: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(tools): interactive tool browser with search, README preview, and subcommand explorer"
```

---

### Task 8: Wire entry point to use src/tools/ when no args

**Files:**
- Modify: `tools` (the main entry point, lines 149-153)

Replace the old `@inquirer/prompts` selector with a delegation to `src/tools/index.ts`.

**Step 1: Replace the no-args branch**

Replace lines 149-153 in `tools`:

```ts
if (args.length === 0) {
    // Launch interactive tool browser
    const result = spawnSync("bun", ["run", join(srcDir, "tools", "index.ts")], {
        stdio: "inherit",
        cwd: process.cwd(),
    });
    process.exit(result.status ?? 0);
}
```

**Step 2: Clean up unused imports**

Remove these imports from `tools` since they're no longer needed:
- `search` from `@inquirer/prompts`
- `ExitPromptError` from `@inquirer/core`
- `clipboardy`

Also remove the functions:
- `selectToolAndCopyCommand()` (lines 55-83)
- `getAvailableTools()` — keep this one if fuzzy matching (Task 3) still uses it; otherwise extract to discovery module

**Step 3: Test**

```bash
bun run tools
```

Expected: Launches the new interactive browser with logo and search.

```bash
bun run tools git-commit
```

Expected: Still runs git-commit directly (exact match path unchanged).

**Step 4: Commit**

```bash
git add tools
git commit -m "feat: wire tools entry point to new interactive browser"
```

---

### Task 9: Enhance markdown engine with options

**Files:**
- Modify: `src/utils/markdown/index.ts` (lines 316-323)

Add an options parameter to `renderMarkdownToCli()` for width and theme control.

**Step 1: Add options interface and update function**

Add before the `renderMarkdownToCli` function:

```ts
export interface MarkdownRenderOptions {
    /** Max output width in columns. Defaults to terminal width or 80. */
    width?: number;
    /** Color theme. Defaults to "dark". */
    theme?: "dark" | "light" | "minimal";
    /** Whether to include ANSI colors. Defaults to true. */
    color?: boolean;
}
```

Update the function signature:

```ts
export function renderMarkdownToCli(markdown: string, options?: MarkdownRenderOptions): string {
    if (!mdInstance) {
        mdInstance = createMarkdownRenderer();
    }

    const html = mdInstance.render(markdown);
    let output = cliHtml(html);

    // Apply width constraint
    if (options?.width) {
        output = wrapToWidth(output, options.width);
    }

    // Strip colors if requested
    if (options?.color === false) {
        output = stripAnsi(output);
    }

    return output;
}
```

Add helper functions:

```ts
function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrapToWidth(str: string, width: number): string {
    // Simple line wrapping that respects ANSI codes
    return str.split("\n").map(line => {
        const plainLength = stripAnsi(line).length;
        if (plainLength <= width) return line;
        // For lines that exceed width, truncate (preserving ANSI reset)
        return line.slice(0, width * 2) + "\x1b[0m"; // rough heuristic for ANSI overhead
    }).join("\n");
}
```

Note: The `wrapToWidth` is intentionally simple. A full ANSI-aware word-wrap is complex; start simple and iterate.

**Step 2: Verify existing callers still work**

The function signature change is backwards-compatible (options is optional). Check:

```bash
bunx tsgo --noEmit 2>&1 | grep "markdown"
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/utils/markdown/index.ts
git commit -m "feat(markdown): add width, theme, and color options to renderMarkdownToCli"
```

---

### Task 10: Enhance markdown-cli with new flags

**Files:**
- Modify: `src/markdown-cli/index.ts`

Add `--watch`, `--width`, `--theme`, `--no-color` flags.

**Step 1: Add new CLI options**

Update `src/markdown-cli/index.ts`:

```ts
#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import chokidar from "chokidar";
import { renderMarkdownToCli, type MarkdownRenderOptions } from "../utils/markdown/index.js";

const program = new Command();

program
    .name("markdown-cli")
    .description("Render markdown to beautiful CLI output")
    .argument("[file]", "Markdown file to render (or pipe via stdin)")
    .option("-w, --watch", "Watch file for changes and re-render")
    .option("--width <n>", "Max output width in columns", parseInt)
    .option("--theme <name>", "Color theme: dark, light, minimal", "dark")
    .option("--no-color", "Strip ANSI color codes from output")
    .action((file: string | undefined, opts: { watch?: boolean; width?: number; theme?: string; color?: boolean }) => {
        const renderOpts: MarkdownRenderOptions = {
            width: opts.width,
            theme: (opts.theme as MarkdownRenderOptions["theme"]) || "dark",
            color: opts.color !== false,
        };

        if (!process.stdin.isTTY) {
            // Pipe mode — read stdin
            const markdown = readFileSync(0, "utf-8");
            console.log(renderMarkdownToCli(markdown, renderOpts));
            return;
        }

        if (!file) {
            program.help();
            return;
        }

        const filePath = resolve(file);
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }

        function renderFile() {
            const markdown = readFileSync(filePath, "utf-8");
            // Clear screen in watch mode
            if (opts.watch) {
                process.stdout.write("\x1b[2J\x1b[H");
            }
            console.log(renderMarkdownToCli(markdown, renderOpts));
        }

        renderFile();

        if (opts.watch) {
            console.log(`\n--- Watching ${filePath} for changes (Ctrl+C to stop) ---\n`);
            const watcher = chokidar.watch(filePath, { ignoreInitial: true });
            watcher.on("change", () => {
                renderFile();
            });
        }
    });

program.parse();
```

**Step 2: Test the new flags**

```bash
# Basic render (should still work)
bun run src/markdown-cli/index.ts README.md

# With width constraint
bun run src/markdown-cli/index.ts README.md --width 60

# Without colors
bun run src/markdown-cli/index.ts README.md --no-color

# Watch mode (Ctrl+C to stop)
bun run src/markdown-cli/index.ts README.md --watch
```

**Step 3: Commit**

```bash
git add src/markdown-cli/index.ts
git commit -m "feat(markdown-cli): add --watch, --width, --theme, --no-color flags"
```

---

### Task 11: Final integration test and cleanup

**Files:**
- Review all modified files
- Clean up any unused imports in `tools` entry point

**Step 1: Run full integration tests**

```bash
# Entry point — no args (new browser)
bun run tools

# Entry point — exact match
bun run tools json --help

# Entry point — fuzzy match
bun run tools cli-

# Entry point — no match
bun run tools zzzzz

# Markdown-cli — basic
echo "# Hello\n\nWorld" | bun run src/markdown-cli/index.ts

# Markdown-cli — width
echo "# Hello\n\nThis is a very long line that should be wrapped at the specified width boundary" | bun run src/markdown-cli/index.ts --width 40
```

**Step 2: Verify no TypeScript errors**

```bash
bunx tsgo --noEmit 2>&1 | head -20
```

Expected: No errors (or only pre-existing ones).

**Step 3: Clean up any stale imports/functions**

Review the `tools` entry point for any leftover imports from the old implementation that are no longer needed.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: integration test cleanup and unused import removal"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Create branch + scaffold | `src/tools/index.ts` |
| 2 | Fix error formatting | `tools` |
| 3 | Add fuzzy matching | `tools` |
| 4 | Tool discovery module | `src/tools/lib/discovery.ts` |
| 5 | Commander introspection | `src/tools/lib/introspect.ts` |
| 6 | Search-select prompt | `src/utils/prompts/clack/search-select.ts` |
| 7 | Interactive browser | `src/tools/index.ts` |
| 8 | Wire entry point | `tools` |
| 9 | Markdown engine options | `src/utils/markdown/index.ts` |
| 10 | Markdown-cli flags | `src/markdown-cli/index.ts` |
| 11 | Integration test + cleanup | All files |
