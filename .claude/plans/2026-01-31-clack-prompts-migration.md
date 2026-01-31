# Clack Prompts Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate all GenesisTools CLI tools from `@inquirer/prompts` to `@clack/prompts` with `picocolors` for consistent, beautiful CLI interfaces.

**Architecture:** Create shared utilities for prompts and colors, then migrate each tool file-by-file following the vercel-skills patterns. Each tool gets a modern CLI experience with spinners, structured logging, and proper session management.

**Tech Stack:** `@clack/prompts`, `picocolors`, TypeScript, Bun

---

## Agent Orchestration

This plan is designed for parallel agent execution. Tasks are grouped into waves that can run concurrently.

### Wave 1: Foundation (Sequential)
- Task 1: Install dependencies
- Task 2: Create shared utilities

### Wave 2: Core Tools (3 agents in parallel)
- Agent A: Tools 1-6 (mcp-manager, azure-devops, github)
- Agent B: Tools 7-12 (git-*, timely)
- Agent C: Tools 13-18 (ask, cursor-context, misc)

### Wave 3: Finalization (Sequential)
- Task 3: Update documentation
- Note: Keep both @inquirer and @clack - gradual migration, no forced removal

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install new dependencies**

```bash
bun add @clack/prompts picocolors
```

**Step 2: Verify installation**

```bash
bun run tsgo --noEmit 2>&1 | head -20
```
Expected: No new type errors

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add @clack/prompts and picocolors dependencies"
```

---

## Task 2: Create Shared Utilities

**Directory Structure:**
```
src/utils/prompts/
├── index.ts              # Barrel export for all
├── colors.ts             # Shared color constants (used by both)
├── inquirer/
│   ├── index.ts          # Barrel export for inquirer utils
│   └── helpers.ts        # ExitPromptError handling, wrappers
└── clack/
    ├── index.ts          # Barrel export for clack utils
    ├── helpers.ts        # withCancel, handleCancel, multiselect wrapper
    └── search-multiselect.ts  # Custom searchable multi-select
```

**Files:**
- Create: `src/utils/prompts/index.ts`
- Create: `src/utils/prompts/colors.ts`
- Create: `src/utils/prompts/inquirer/index.ts`
- Create: `src/utils/prompts/inquirer/helpers.ts`
- Create: `src/utils/prompts/clack/index.ts`
- Create: `src/utils/prompts/clack/helpers.ts`
- Create: `src/utils/prompts/clack/search-multiselect.ts`

### Step 1: Create shared colors utility

Create `src/utils/prompts/colors.ts`:

```typescript
import pc from 'picocolors';

// ANSI 256-color constants for advanced styling
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[38;5;102m';     // Darker gray for secondary text
export const TEXT = '\x1b[38;5;145m';    // Lighter gray for primary text
export const CYAN = '\x1b[36m';
export const MAGENTA = '\x1b[35m';
export const YELLOW = '\x1b[33m';

// Logo gradient (for ASCII art if needed)
export const GRAYS = [
  '\x1b[38;5;250m',
  '\x1b[38;5;248m',
  '\x1b[38;5;245m',
  '\x1b[38;5;243m',
  '\x1b[38;5;240m',
  '\x1b[38;5;238m',
];

// Re-export picocolors for convenience
export { pc };

// Common styled outputs
export const styled = {
  error: (msg: string) => `${pc.bgRed(pc.white(pc.bold(' ERROR ')))} ${pc.red(msg)}`,
  success: (msg: string) => `${pc.green('✓')} ${msg}`,
  info: (msg: string) => `${pc.cyan('ℹ')} ${msg}`,
  warning: (msg: string) => `${pc.yellow('⚠')} ${msg}`,
  dim: (msg: string) => pc.dim(msg),
  highlight: (msg: string) => pc.cyan(msg),
};
```

### Step 2: Create inquirer helpers

Create `src/utils/prompts/inquirer/helpers.ts`:

```typescript
import { ExitPromptError } from '@inquirer/core';

/**
 * Check if error is a user cancellation (Ctrl+C / Escape)
 */
export function isUserCancellation(error: unknown): error is ExitPromptError {
  return error instanceof ExitPromptError;
}

/**
 * Wrap an async function to handle ExitPromptError gracefully
 */
export async function withCancellationHandling<T>(
  fn: () => Promise<T>,
  onCancel?: () => void
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (isUserCancellation(error)) {
      onCancel?.();
      return undefined;
    }
    throw error;
  }
}

// Re-export for convenience
export { ExitPromptError } from '@inquirer/core';
```

Create `src/utils/prompts/inquirer/index.ts`:

```typescript
export * from './helpers';
```

### Step 3: Create clack helpers

Create `src/utils/prompts/clack/helpers.ts`:

```typescript
import * as p from '@clack/prompts';
import pc from 'picocolors';

/**
 * Check if a value is a cancel symbol (user pressed Escape/Ctrl+C)
 */
export const isCancelled = (value: unknown): value is symbol =>
  typeof value === 'symbol';

/**
 * Handle cancellation with consistent messaging
 */
export function handleCancel(message = 'Operation cancelled'): never {
  p.cancel(message);
  process.exit(0);
}

/**
 * Wrapper for prompts that handles cancellation automatically
 */
export async function withCancel<T>(
  promptResult: Promise<T | symbol>,
  cancelMessage?: string
): Promise<T> {
  const result = await promptResult;
  if (p.isCancel(result)) {
    handleCancel(cancelMessage);
  }
  return result as T;
}

/**
 * Enhanced multiselect with hint for keyboard usage
 */
export function multiselect<Value>(opts: {
  message: string;
  options: Array<{ value: Value; label: string; hint?: string }>;
  initialValues?: Value[];
  required?: boolean;
}) {
  return p.multiselect({
    ...opts,
    options: opts.options as p.Option<Value>[],
    message: `${opts.message} ${pc.dim('(space to toggle)')}`,
  }) as Promise<Value[] | symbol>;
}

/**
 * Format a list of items, truncating if too long
 */
export function formatList(items: string[], maxShow = 5): string {
  if (items.length <= maxShow) {
    return items.join(', ');
  }
  const shown = items.slice(0, maxShow);
  const remaining = items.length - maxShow;
  return `${shown.join(', ')} +${remaining} more`;
}

// Re-export clack prompts for convenience
export { p };
```

### Step 4: Copy and adapt search-multiselect

Create `src/utils/prompts/clack/search-multiselect.ts`:

```typescript
import * as readline from 'readline';
import { Writable } from 'stream';
import pc from 'picocolors';

// Silent writable stream to prevent readline from echoing input
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export interface SearchItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SearchMultiselectOptions<T> {
  message: string;
  items: SearchItem<T>[];
  maxVisible?: number;
  initialSelected?: T[];
}

const S_STEP_ACTIVE = pc.green('◆');
const S_STEP_CANCEL = pc.red('■');
const S_STEP_SUBMIT = pc.green('◇');
const S_RADIO_ACTIVE = pc.green('●');
const S_RADIO_INACTIVE = pc.dim('○');
const S_BAR = pc.dim('│');

export const cancelSymbol = Symbol('cancel');

/**
 * Interactive search multiselect prompt.
 * Allows users to filter a long list by typing and select multiple items.
 */
export async function searchMultiselect<T>(
  options: SearchMultiselectOptions<T>
): Promise<T[] | symbol> {
  const { message, items, maxVisible = 8, initialSelected = [] } = options;

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: silentOutput,
      terminal: false,
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(process.stdin, rl);

    let query = '';
    let cursor = 0;
    const selected = new Set<T>(initialSelected);
    let lastRenderHeight = 0;

    const filter = (item: SearchItem<T>, q: string): boolean => {
      if (!q) return true;
      const lowerQ = q.toLowerCase();
      return (
        item.label.toLowerCase().includes(lowerQ) ||
        String(item.value).toLowerCase().includes(lowerQ)
      );
    };

    const getFiltered = (): SearchItem<T>[] => {
      return items.filter((item) => filter(item, query));
    };

    const clearRender = (): void => {
      if (lastRenderHeight > 0) {
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
        for (let i = 0; i < lastRenderHeight; i++) {
          process.stdout.write('\x1b[2K\x1b[1B');
        }
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
      }
    };

    const render = (state: 'active' | 'submit' | 'cancel' = 'active'): void => {
      clearRender();

      const lines: string[] = [];
      const filtered = getFiltered();

      const icon =
        state === 'active' ? S_STEP_ACTIVE : state === 'cancel' ? S_STEP_CANCEL : S_STEP_SUBMIT;
      lines.push(`${icon}  ${pc.bold(message)}`);

      if (state === 'active') {
        const searchLine = `${S_BAR}  ${pc.dim('Search:')} ${query}${pc.inverse(' ')}`;
        lines.push(searchLine);
        lines.push(`${S_BAR}  ${pc.dim('↑↓ move, space select, enter confirm')}`);
        lines.push(`${S_BAR}`);

        const visibleStart = Math.max(
          0,
          Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible)
        );
        const visibleEnd = Math.min(filtered.length, visibleStart + maxVisible);
        const visibleItems = filtered.slice(visibleStart, visibleEnd);

        if (filtered.length === 0) {
          lines.push(`${S_BAR}  ${pc.dim('No matches found')}`);
        } else {
          for (let i = 0; i < visibleItems.length; i++) {
            const item = visibleItems[i]!;
            const actualIndex = visibleStart + i;
            const isSelected = selected.has(item.value);
            const isCursor = actualIndex === cursor;

            const radio = isSelected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
            const label = isCursor ? pc.underline(item.label) : item.label;
            const hint = item.hint ? pc.dim(` (${item.hint})`) : '';

            const prefix = isCursor ? pc.cyan('❯') : ' ';
            lines.push(`${S_BAR} ${prefix} ${radio} ${label}${hint}`);
          }

          const hiddenBefore = visibleStart;
          const hiddenAfter = filtered.length - visibleEnd;
          if (hiddenBefore > 0 || hiddenAfter > 0) {
            const parts: string[] = [];
            if (hiddenBefore > 0) parts.push(`↑ ${hiddenBefore} more`);
            if (hiddenAfter > 0) parts.push(`↓ ${hiddenAfter} more`);
            lines.push(`${S_BAR}  ${pc.dim(parts.join('  '))}`);
          }
        }

        lines.push(`${S_BAR}`);
        if (selected.size === 0) {
          lines.push(`${S_BAR}  ${pc.dim('Selected: (none)')}`);
        } else {
          const selectedLabels = items
            .filter((item) => selected.has(item.value))
            .map((item) => item.label);
          const summary =
            selectedLabels.length <= 3
              ? selectedLabels.join(', ')
              : `${selectedLabels.slice(0, 3).join(', ')} +${selectedLabels.length - 3} more`;
          lines.push(`${S_BAR}  ${pc.green('Selected:')} ${summary}`);
        }

        lines.push(`${pc.dim('└')}`);
      } else if (state === 'submit') {
        const selectedLabels = items
          .filter((item) => selected.has(item.value))
          .map((item) => item.label);
        lines.push(`${S_BAR}  ${pc.dim(selectedLabels.join(', '))}`);
      } else if (state === 'cancel') {
        lines.push(`${S_BAR}  ${pc.strikethrough(pc.dim('Cancelled'))}`);
      }

      process.stdout.write(lines.join('\n') + '\n');
      lastRenderHeight = lines.length;
    };

    const cleanup = (): void => {
      process.stdin.removeListener('keypress', keypressHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      rl.close();
    };

    const submit = (): void => {
      render('submit');
      cleanup();
      resolve(Array.from(selected));
    };

    const cancel = (): void => {
      render('cancel');
      cleanup();
      resolve(cancelSymbol);
    };

    const keypressHandler = (_str: string, key: readline.Key): void => {
      if (!key) return;

      const filtered = getFiltered();

      if (key.name === 'return') {
        submit();
        return;
      }

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cancel();
        return;
      }

      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }

      if (key.name === 'down') {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
        return;
      }

      if (key.name === 'space') {
        const item = filtered[cursor];
        if (item) {
          if (selected.has(item.value)) {
            selected.delete(item.value);
          } else {
            selected.add(item.value);
          }
        }
        render();
        return;
      }

      if (key.name === 'backspace') {
        query = query.slice(0, -1);
        cursor = 0;
        render();
        return;
      }

      if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
        query += key.sequence;
        cursor = 0;
        render();
        return;
      }
    };

    process.stdin.on('keypress', keypressHandler);
    render();
  });
}
```

### Step 5: Create clack barrel export

Create `src/utils/prompts/clack/index.ts`:

```typescript
export * from './helpers';
export * from './search-multiselect';
```

### Step 6: Create main barrel export

Create `src/utils/prompts/index.ts`:

```typescript
// Shared utilities
export * from './colors';

// Library-specific utilities (import from subdirectories)
// import { withCancel, handleCancel } from '@/utils/prompts/clack';
// import { isUserCancellation } from '@/utils/prompts/inquirer';
```

### Step 7: Verify build

```bash
bun run tsgo --noEmit 2>&1 | rg "prompts"
```
Expected: No errors related to prompts

### Step 8: Commit

```bash
git add src/utils/prompts/
git commit -m "feat: add shared clack prompts utilities"
```

---

## Task 3: Migrate Main Entry Point (tools)

**Files:**
- Modify: `tools`

**Step 1: Update imports**

Replace:
```typescript
import { search } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
```

With:
```typescript
import * as p from '@clack/prompts';
import pc from 'picocolors';
```

**Step 2: Update selectToolAndCopyCommand function**

Replace the function with:

```typescript
async function selectToolAndCopyCommand(tools: string[]) {
  if (tools.length === 0) {
    p.log.info("No tools found in the src directory.");
    process.exit(0);
  }

  p.intro(pc.bgCyan(pc.black(' tools ')));

  const tool = await p.select({
    message: "Select a tool to copy its command:",
    options: tools.map(t => ({ value: t, label: t })),
  });

  if (p.isCancel(tool)) {
    p.cancel("Tool selection cancelled");
    process.exit(0);
  }

  const commandToCopy = `${EXECUTABLE_NAME} ${tool}`;
  await clipboardy.write(commandToCopy);

  p.outro(pc.green(`Command "${commandToCopy}" copied to clipboard!`));
}
```

**Step 3: Test**

```bash
tools
```
Expected: Shows styled tool selector with intro/outro

**Step 4: Commit**

```bash
git add tools
git commit -m "refactor(tools): migrate to @clack/prompts"
```

---

## Task 4-9: Migrate mcp-manager (6 files)

### Task 4: mcp-manager/index.ts

**Files:**
- Modify: `src/mcp-manager/index.ts`

**Step 1: Update imports**

Replace:
```typescript
import { select, input } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
```

With:
```typescript
import * as p from '@clack/prompts';
import pc from 'picocolors';
```

**Step 2: Update error handling pattern**

Replace all `try/catch` with `ExitPromptError` checks with `p.isCancel()` checks after each prompt.

### Task 5: mcp-manager/commands/install.ts

**Files:**
- Modify: `src/mcp-manager/commands/install.ts`

Replace `search`, `input`, `select` with clack equivalents.

### Task 6: mcp-manager/commands/sync.ts

**Files:**
- Modify: `src/mcp-manager/commands/sync.ts`

Replace `checkbox` with `p.multiselect()`.

### Task 7: mcp-manager/commands/sync-from-providers.ts

**Files:**
- Modify: `src/mcp-manager/commands/sync-from-providers.ts`

### Task 8: mcp-manager/commands/rename.ts

**Files:**
- Modify: `src/mcp-manager/commands/rename.ts`

### Task 9: mcp-manager/utils files

**Files:**
- Modify: `src/mcp-manager/utils/backup.ts`
- Modify: `src/mcp-manager/utils/command.utils.ts`

---

## Task 10-11: Migrate azure-devops

### Task 10: azure-devops/index.ts

**Files:**
- Modify: `src/azure-devops/index.ts`

This is a complex file with `input`, `select`, `confirm`, and `editor` prompts.

**Note:** `editor` prompt doesn't exist in clack. Options:
1. Use `p.text()` with multiline hint
2. Keep `@inquirer/prompts` editor only
3. Use external editor via Bun.spawn

Recommended: Use `p.text()` for now, or implement custom editor later.

---

## Task 12: Migrate github/index.ts

**Files:**
- Modify: `src/github/index.ts`

Replace `select`, `input`, `confirm` with clack equivalents.

---

## Task 13-16: Migrate git-* tools

### Task 13: git-commit/index.ts

**Files:**
- Modify: `src/git-commit/index.ts`

Simple migration: `select` and `confirm` only.

### Task 14: git-last-commits-diff/index.ts

**Files:**
- Modify: `src/git-last-commits-diff/index.ts`

Uses `search`, `select`, `input`. Replace `search` with custom `searchMultiselect` if filtering is needed, or `p.select()` with options.

### Task 15: git-rebase-multiple/prompts.ts

**Files:**
- Modify: `src/git-rebase-multiple/prompts.ts`

Complex file with `search`, `checkbox`, `confirm`, `input`, `select`.

### Task 16: rename-commits/index.ts

**Files:**
- Modify: `src/rename-commits/index.ts`

Uses `input`, `confirm`, `number`. Note: `number` prompt doesn't exist in clack - use `p.text()` with number validation.

---

## Task 17-21: Migrate timely tool

### Task 17: timely/commands/login.ts

**Files:**
- Modify: `src/timely/commands/login.ts`

Uses `confirm`, `input`, `password`. Note: `password` is `p.password()` in clack.

### Task 18: timely/commands/accounts.ts

**Files:**
- Modify: `src/timely/commands/accounts.ts`

### Task 19: timely/commands/projects.ts

**Files:**
- Modify: `src/timely/commands/projects.ts`

### Task 20: timely/commands/cache.ts

**Files:**
- Modify: `src/timely/commands/cache.ts`

### Task 21: timely/api/client.ts

**Files:**
- Modify: `src/timely/api/client.ts`

---

## Task 22-25: Migrate ask tool

### Task 22: ask/index.ts

**Files:**
- Modify: `src/ask/index.ts`

### Task 23: ask/providers/ModelSelector.ts

**Files:**
- Modify: `src/ask/providers/ModelSelector.ts`

Uses `select`, `search`. Replace with clack equivalents.

### Task 24: ask/chat/CommandHandler.ts

**Files:**
- Modify: `src/ask/chat/CommandHandler.ts`

---

## Task 25-28: Migrate remaining tools

### Task 25: cursor-context/index.ts

**Files:**
- Modify: `src/cursor-context/index.ts`

### Task 26: watchman/index.ts

**Files:**
- Modify: `src/watchman/index.ts`

Uses `search` prompt. Consider using custom searchMultiselect or p.select with filtered options.

### Task 27: macos-eslogger/index.ts

**Files:**
- Modify: `src/macos-eslogger/index.ts`

### Task 28: claude-history/index.ts

**Files:**
- Modify: `src/claude-history/index.ts`

### Task 29: hold-ai/server.ts

**Files:**
- Modify: `src/hold-ai/server.ts`

Uses `editor` prompt. Needs special handling.

---

## Task 30: Update prompt-helpers utility

**Files:**
- Modify: `src/utils/prompt-helpers.ts`

This file currently exports `ExitPromptError`. Update to export clack helpers instead:

```typescript
import * as p from '@clack/prompts';

export const isCancel = p.isCancel;
export const handleCancel = (message = 'Operation cancelled') => {
  p.cancel(message);
  process.exit(0);
};
```

---

## Note: Keeping Both Libraries

**Important:** We will keep both `@inquirer/prompts` and `@clack/prompts` installed. This is a gradual migration - tools can be migrated one at a time without breaking existing functionality.

- `@inquirer/prompts` - Keep for tools not yet migrated and for `editor` prompt (no clack equivalent)
- `@clack/prompts` - Use for newly migrated tools

No removal of old dependencies is needed.

### When to Use Which Library

| Scenario | Recommendation |
|----------|----------------|
| Multi-step wizard with spinners | @clack/prompts |
| Need `p.intro()` / `p.outro()` session flow | @clack/prompts |
| Need `p.spinner()` for async operations | @clack/prompts |
| Need structured `p.log.*` output | @clack/prompts |
| Need `editor` prompt (multiline text editor) | @inquirer/prompts |
| Need `number` prompt with validation | @inquirer/prompts (or clack text + validate) |
| Modifying existing @inquirer tool | Stay with @inquirer |
| Brand new tool | @clack/prompts (preferred) |

---

## Task 0: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/docs/testing.md`
- Already created: `docs/prompts-and-colors.md`

### Step 1: Update CLAUDE.md

Add "Choosing a Prompt Library" section after line 68 (after the existing @inquirer template section) with:
- Comparison table for when to use each library
- New tool template using @clack/prompts pattern

### Step 2: Update .claude/docs/testing.md

Add new section "Testing @clack/prompts" with:
- Mocking pattern for clack (different from inquirer)
- Example of testing cancel via `p.isCancel()` and symbols

### Step 3: Commit

```bash
git add CLAUDE.md .claude/docs/testing.md docs/prompts-and-colors.md
git commit -m "docs: add clack prompts documentation and usage guidelines"
```

---

## Task 31: Final Testing & Documentation

**Step 1: Type check**

```bash
bun run tsgo --noEmit
```

**Step 2: Test each tool interactively**

```bash
tools                          # Main selector
tools mcp-manager list         # mcp-manager
tools azure-devops --help      # azure-devops
tools git-commit --help        # git-commit
tools claude-history           # claude-history
```

**Step 3: Verify both libraries work**

```bash
# Test a clack tool
tools <migrated-tool>

# Test an inquirer tool (if any remain unmigrated)
tools <unmigrated-tool>
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete clack prompts migration for tools"
```

---

## Summary: Files to Migrate

| # | File | Prompts Used | Complexity |
|---|------|--------------|------------|
| 1 | `tools` | search | Low |
| 2 | `src/mcp-manager/index.ts` | select, input | Medium |
| 3 | `src/mcp-manager/commands/install.ts` | search, input, select | Medium |
| 4 | `src/mcp-manager/commands/sync.ts` | checkbox | Low |
| 5 | `src/mcp-manager/commands/sync-from-providers.ts` | checkbox, select | Low |
| 6 | `src/mcp-manager/commands/rename.ts` | search, input, confirm, checkbox | High |
| 7 | `src/mcp-manager/utils/backup.ts` | confirm | Low |
| 8 | `src/mcp-manager/utils/command.utils.ts` | checkbox | Low |
| 9 | `src/azure-devops/index.ts` | input, select, confirm, editor | High |
| 10 | `src/github/index.ts` | select, input, confirm | Medium |
| 11 | `src/git-commit/index.ts` | select, confirm | Low |
| 12 | `src/git-last-commits-diff/index.ts` | search, select, input | Medium |
| 13 | `src/git-rebase-multiple/prompts.ts` | search, checkbox, confirm, input, select | High |
| 14 | `src/rename-commits/index.ts` | input, confirm, number | Medium |
| 15 | `src/timely/commands/login.ts` | confirm, input, password | Medium |
| 16 | `src/timely/commands/accounts.ts` | select | Low |
| 17 | `src/timely/commands/projects.ts` | select | Low |
| 18 | `src/timely/commands/cache.ts` | confirm | Low |
| 19 | `src/timely/api/client.ts` | input, password | Low |
| 20 | `src/ask/index.ts` | input | Low |
| 21 | `src/ask/providers/ModelSelector.ts` | select, search | Medium |
| 22 | `src/ask/chat/CommandHandler.ts` | input, confirm, select, password | Medium |
| 23 | `src/cursor-context/index.ts` | checkbox, confirm, input | Medium |
| 24 | `src/watchman/index.ts` | search | Low |
| 25 | `src/macos-eslogger/index.ts` | select, checkbox | Low |
| 26 | `src/claude-history/index.ts` | search, select, input | Medium |
| 27 | `src/hold-ai/server.ts` | editor | Medium |
| 28 | `src/utils/prompt-helpers.ts` | ExitPromptError | Low |

**Total: 28 files**

---

## Prompt Mapping Reference

| @inquirer/prompts | @clack/prompts | Notes |
|-------------------|----------------|-------|
| `input()` | `p.text()` | Use `validate` for validation |
| `select()` | `p.select()` | Options format differs |
| `confirm()` | `p.confirm()` | Same API |
| `checkbox()` | `p.multiselect()` | Add hint for space toggle |
| `search()` | `p.select()` or custom | Use custom searchMultiselect for filtering |
| `password()` | `p.password()` | Same API |
| `editor()` | N/A | Keep inquirer or use external editor |
| `number()` | `p.text()` + validation | Validate as number |
| `ExitPromptError` | `p.isCancel()` | Check after each prompt |

---

## Execution Options

**Option 1: Subagent-Driven (this session)**
- I dispatch fresh subagent per task
- Review between tasks
- Fast iteration

**Option 2: Parallel Session (separate)**
- Open new session with executing-plans
- Batch execution with checkpoints
