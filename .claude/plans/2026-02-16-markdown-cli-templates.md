# Markdown-CLI Templates & Demo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `demo` subcommand to `markdown-cli` that lets users browse and view pre-built markdown templates showcasing all rendering capabilities (alerts, tables, code blocks, mermaid, task lists, full reports).

**Architecture:** Templates are stored as plain `.md` files in `src/markdown-cli/templates/`. The `demo` subcommand uses @clack/prompts to let users browse templates, then renders the selected one using the existing `renderMarkdownToCli()` engine. A `--list` flag prints available templates non-interactively.

**Tech Stack:** Commander (existing), @clack/prompts (existing), renderMarkdownToCli (existing), picocolors (existing)

**Branch:** `feat/tools-index-markdown` (add to existing PR)

---

### Task 1: Create markdown template files

**Files:**
- Create: `src/markdown-cli/templates/alerts.md`
- Create: `src/markdown-cli/templates/tables.md`
- Create: `src/markdown-cli/templates/code-blocks.md`
- Create: `src/markdown-cli/templates/mermaid.md`
- Create: `src/markdown-cli/templates/task-lists.md`
- Create: `src/markdown-cli/templates/full-report.md`

**Step 1: Create `alerts.md`**

```markdown
# GitHub-Style Alerts

> [!NOTE]
> This is a note with helpful information for the reader.

> [!TIP]
> This is a tip with a helpful suggestion.

> [!IMPORTANT]
> This is important information the reader should know.

> [!WARNING]
> This is a warning about potential issues.

> [!CAUTION]
> This is a caution about dangerous actions.

## Nested Content in Alerts

> [!NOTE]
> Alerts can contain **bold**, *italic*, `code`, and [links](https://example.com).
>
> They can also span multiple paragraphs.
```

**Step 2: Create `tables.md`**

```markdown
# Table Rendering

## Basic Table

| Tool | Language | Stars |
|------|----------|------:|
| GenesisTools | TypeScript | 42 |
| Bun | Zig/C++ | 74,000 |
| Deno | Rust | 98,000 |

## Table with Alignment

| Left | Center | Right |
|:-----|:------:|------:|
| Hello | World | 123 |
| Longer text here | Centered | 9,999 |
| Short | Yes | 1 |

## Table with Emoji

| Status | Task | Priority |
|--------|------|----------|
| Done | Setup project | High |
| In Progress | Add templates | Medium |
| Pending | Write docs | Low |
```

**Step 3: Create `code-blocks.md`**

```markdown
# Code Block Rendering

## TypeScript (with line numbers)

\`\`\`ts
interface ToolInfo {
    name: string;
    description: string;
    hasReadme: boolean;
    path: string;
}

export function discoverTools(srcDir: string): ToolInfo[] {
    const tools: ToolInfo[] = [];
    return tools.sort((a, b) => a.name.localeCompare(b.name));
}
\`\`\`

## Shell Commands (no line numbers)

\`\`\`bash
# Install dependencies
bun install

# Run a tool
tools markdown-cli demo

# Watch mode
tools markdown-cli README.md --watch
\`\`\`

## JSON Configuration

\`\`\`json
{
    "name": "genesis-tools",
    "version": "1.0.0",
    "type": "module",
    "scripts": {
        "start": "bun run tools"
    }
}
\`\`\`

## Inline Code

Use \`renderMarkdownToCli()\` to render markdown. The \`--watch\` flag enables live reload.
```

**Step 4: Create `mermaid.md`**

```markdown
# Mermaid Diagrams

## Flowchart

\`\`\`mermaid
graph TD
    A[User runs tools] --> B{Has arguments?}
    B -->|No| C[Interactive Browser]
    B -->|Yes| D{Exact match?}
    D -->|Yes| E[Run tool]
    D -->|No| F[Fuzzy search]
    F --> G[Show selector]
\`\`\`

## Sequence Diagram

\`\`\`mermaid
sequenceDiagram
    User->>CLI: tools markdown-cli demo
    CLI->>Templates: Load available templates
    Templates-->>CLI: Template list
    CLI->>User: Show selector
    User->>CLI: Select template
    CLI->>Renderer: renderMarkdownToCli()
    Renderer-->>CLI: Formatted output
    CLI->>User: Display rendered markdown
\`\`\`

## Gantt Chart

\`\`\`mermaid
gantt
    title GenesisTools Roadmap
    section Core
    Tool discovery    :done, d1, 2026-01-01, 30d
    Interactive browser :active, d2, after d1, 14d
    section Markdown
    Templates          :d3, after d2, 7d
    Demo mode          :d4, after d3, 3d
\`\`\`
```

**Step 5: Create `task-lists.md`**

```markdown
# Task Lists

## Project Checklist

- [x] Set up project structure
- [x] Implement markdown rendering engine
- [x] Add GitHub-style alerts
- [x] Add table rendering with box-drawing
- [ ] Add pager mode for long documents
- [ ] Add PDF export

## Nested Tasks

- [x] Phase 1: Core
    - [x] CLI entry point
    - [x] Markdown-it configuration
    - [x] Custom fence plugin
- [ ] Phase 2: Enhancements
    - [x] Watch mode
    - [x] Width control
    - [ ] Theme system
    - [ ] Template gallery
```

**Step 6: Create `full-report.md`**

This template combines ALL features into a single showcase document:

```markdown
# GenesisTools Markdown Rendering Report

> [!NOTE]
> This is a showcase of all markdown rendering capabilities in GenesisTools CLI.

---

## Overview

The **markdown-cli** tool renders markdown to beautiful terminal output. It supports:
- GitHub-style alerts with colored borders
- Tables with box-drawing characters and alignment
- Code blocks with syntax-aware line numbering
- Mermaid diagram visualization
- Task lists with checkboxes

## Feature Matrix

| Feature | Status | Engine |
|---------|:------:|--------|
| Alerts | Supported | @mdit/plugin-alert |
| Tables | Supported | Custom ASCII renderer |
| Code Blocks | Supported | markdown-it + cli-html |
| Mermaid | Visual only | Custom renderer |
| Task Lists | Supported | markdown-it-task-lists |
| Footnotes | Not yet | markdown-it-footnote |

## Code Example

\`\`\`ts
import { renderMarkdownToCli } from "../utils/markdown/index.js";

const markdown = "# Hello World";
const output = renderMarkdownToCli(markdown, {
    width: 80,
    theme: "dark",
    color: true,
});
console.log(output);
\`\`\`

## Architecture

\`\`\`mermaid
graph LR
    A[Markdown Input] --> B[markdown-it]
    B --> C[HTML]
    C --> D[cli-html]
    D --> E[Terminal Output]
    B --> F[Custom Plugins]
    F --> G[Tables]
    F --> H[Mermaid]
    F --> I[Alerts]
\`\`\`

## Progress

- [x] Core rendering engine
- [x] Watch mode with live reload
- [x] Width and theme options
- [x] Template gallery
- [ ] PDF export
- [ ] Custom themes

> [!TIP]
> Run \`tools markdown-cli demo\` to browse all available templates interactively!
```

**Step 7: Commit templates**

```bash
git add src/markdown-cli/templates/
git commit -m "feat(markdown-cli): add showcase templates for demo mode"
```

---

### Task 2: Add demo subcommand to markdown-cli

**Files:**
- Modify: `src/markdown-cli/index.ts`

The `demo` subcommand:
- No args: interactive @clack/prompts selector showing template names + descriptions
- `--list`: non-interactive, prints available templates
- `--all`: renders all templates in sequence
- Selecting a template renders it with `renderMarkdownToCli()`

**Step 1: Update `src/markdown-cli/index.ts`**

Add these imports at the top:

```ts
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
```

Add a `demo` subcommand BEFORE `program.parse()`:

```ts
program
    .command("demo")
    .description("Browse and preview markdown rendering templates")
    .option("-l, --list", "List available templates")
    .option("-a, --all", "Render all templates in sequence")
    .action(async (opts: { list?: boolean; all?: boolean }) => {
        const templatesDir = join(import.meta.dirname, "templates");
        const templates = readdirSync(templatesDir)
            .filter(f => f.endsWith(".md"))
            .map(f => {
                const content = readFileSync(join(templatesDir, f), "utf-8");
                const firstLine = content.split("\n").find(l => l.startsWith("# "));
                return {
                    file: f,
                    name: basename(f, ".md"),
                    title: firstLine?.replace(/^#\s+/, "") || basename(f, ".md"),
                    path: join(templatesDir, f),
                };
            });

        if (opts.list) {
            console.log(pc.bold("\nAvailable templates:\n"));
            for (const t of templates) {
                console.log(`  ${pc.cyan(t.name.padEnd(16))} ${pc.dim(t.title)}`);
            }
            console.log();
            return;
        }

        if (opts.all) {
            for (const t of templates) {
                const content = readFileSync(t.path, "utf-8");
                console.log(pc.dim(`\n${"─".repeat(60)}`));
                console.log(pc.bold(pc.cyan(`  Template: ${t.name}`)));
                console.log(pc.dim(`${"─".repeat(60)}\n`));
                console.log(renderMarkdownToCli(content));
            }
            return;
        }

        // Interactive mode
        p.intro(pc.bgCyan(pc.black(" Markdown Template Gallery ")));

        while (true) {
            const selected = await p.select({
                message: "Choose a template to preview:",
                options: [
                    ...templates.map(t => ({
                        value: t.name,
                        label: t.title,
                        hint: t.file,
                    })),
                    { value: "__all__", label: "Render all templates" },
                    { value: "__exit__", label: pc.dim("Exit") },
                ],
            });

            if (p.isCancel(selected) || selected === "__exit__") {
                p.outro(pc.dim("Bye!"));
                break;
            }

            if (selected === "__all__") {
                for (const t of templates) {
                    const content = readFileSync(t.path, "utf-8");
                    console.log(pc.dim(`\n${"─".repeat(60)}`));
                    console.log(pc.bold(pc.cyan(`  Template: ${t.name}`)));
                    console.log(pc.dim(`${"─".repeat(60)}\n`));
                    console.log(renderMarkdownToCli(content));
                }
                continue;
            }

            const template = templates.find(t => t.name === selected);
            if (template) {
                const content = readFileSync(template.path, "utf-8");
                console.log("\n" + renderMarkdownToCli(content) + "\n");
            }
        }
    });
```

**Step 2: Test**

```bash
# List templates
bun run src/markdown-cli/index.ts demo --list

# Render all
bun run src/markdown-cli/index.ts demo --all

# Interactive
bun run src/markdown-cli/index.ts demo
```

**Step 3: Commit**

```bash
git add src/markdown-cli/index.ts
git commit -m "feat(markdown-cli): add demo subcommand with interactive template gallery"
```

---

### Task 3: Verify and final cleanup

**Step 1: Verify TypeScript**

```bash
bunx tsgo --noEmit 2>&1 | grep "markdown-cli"
```

Expected: No new errors.

**Step 2: Test full flow**

```bash
# Original functionality still works
echo "# Test" | bun run src/markdown-cli/index.ts

# Demo list
bun run src/markdown-cli/index.ts demo --list

# Demo all (non-interactive check)
bun run src/markdown-cli/index.ts demo --all

# Via tools entry point
bun run tools markdown-cli demo --list
```

**Step 3: Commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: markdown-cli demo cleanup"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Create 6 template markdown files | `src/markdown-cli/templates/*.md` |
| 2 | Add `demo` subcommand | `src/markdown-cli/index.ts` |
| 3 | Verify + cleanup | All files |
