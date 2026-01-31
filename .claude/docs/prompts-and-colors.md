# Clack Prompts & Picocolors Guide

A comprehensive guide for migrating GenesisTools from `@inquirer/prompts` to `@clack/prompts` with `picocolors` for consistent, beautiful CLI interfaces.

> **Note:** Both libraries coexist in this codebase. See [When to Use Which](#when-to-use-which) for guidance.

## Table of Contents

1. [When to Use Which](#when-to-use-which)
2. [Why Migrate](#why-migrate)
2. [Dependencies](#dependencies)
3. [Picocolors Usage](#picocolors-usage)
4. [Clack Prompts API](#clack-prompts-api)
5. [Custom Color Constants](#custom-color-constants)
6. [Workflow Patterns](#workflow-patterns)
7. [Error Handling](#error-handling)
8. [Custom Components](#custom-components)

---

## When to Use Which

Both `@inquirer/prompts` and `@clack/prompts` are available. Choose based on your needs:

| Scenario | Use | Why |
|----------|-----|-----|
| **Brand new tool** | `@clack/prompts` | Modern API, built-in spinners, beautiful output |
| **Multi-step wizard** | `@clack/prompts` | `p.intro()`, `p.outro()`, `p.spinner()` for flow |
| **Need structured logging** | `@clack/prompts` | `p.log.info/error/warn/step()` |
| **Need `editor` prompt** | `@inquirer/prompts` | No clack equivalent for multiline editor |
| **Need `number` prompt** | `@inquirer/prompts` | Or use clack `text()` with validation |
| **Need `search` with filtering** | Either | Custom `searchMultiselect` works with clack |
| **Modifying existing tool** | Keep current library | Don't mix libraries in same file |

### Quick Decision

```
Is this a NEW tool?
  YES → Use @clack/prompts (preferred)
  NO → Does it need editor prompt?
    YES → Stay with @inquirer/prompts
    NO → Consider migrating to @clack/prompts
```

---

## Why Migrate

| Feature | @inquirer/prompts | @clack/prompts |
|---------|-------------------|----------------|
| Bundle size | Larger | Smaller, zero dependencies |
| Spinner built-in | No (need ora) | Yes (`p.spinner()`) |
| Structured logging | No | Yes (`p.log.*`) |
| Visual consistency | Basic | Beautiful, unified style |
| Cancel handling | `ExitPromptError` | `p.isCancel()` + symbols |
| Session flow | Manual | `p.intro()` / `p.outro()` |

---

## Dependencies

```bash
# Install new libraries (keep existing @inquirer/prompts)
bun add @clack/prompts picocolors
```

> **Note:** We keep both libraries installed. `@inquirer/prompts` is still used for tools not yet migrated and for the `editor` prompt which has no clack equivalent.

**package.json changes:**
```json
{
  "dependencies": {
    "@clack/prompts": "^0.11.0",
    "picocolors": "^1.1.1"
  }
}
```

---

## Picocolors Usage

### Import Pattern

```typescript
import pc from 'picocolors';
```

### Available Colors & Modifiers

```typescript
// Colors
pc.black(text)
pc.red(text)
pc.green(text)
pc.yellow(text)
pc.blue(text)
pc.magenta(text)
pc.cyan(text)
pc.white(text)
pc.gray(text)

// Background colors
pc.bgRed(text)
pc.bgGreen(text)
pc.bgYellow(text)
pc.bgBlue(text)
pc.bgMagenta(text)
pc.bgCyan(text)
pc.bgWhite(text)
pc.bgBlack(text)

// Modifiers
pc.bold(text)
pc.dim(text)
pc.italic(text)
pc.underline(text)
pc.inverse(text)
pc.strikethrough(text)
pc.hidden(text)
pc.reset(text)
```

### Composing Styles

```typescript
// Chain styles
pc.bold(pc.green('Success!'))
pc.dim(pc.cyan('info'))
pc.bgRed(pc.white(pc.bold(' ERROR ')))

// Common patterns
const error = pc.bgRed(pc.white(pc.bold(' ERROR '))) + ' ' + pc.red(message);
const success = pc.green('✓') + ' ' + pc.dim('Done');
const info = pc.cyan('ℹ') + ' ' + text;
const warning = pc.yellow('⚠') + ' ' + text;
```

---

## Clack Prompts API

### Import Pattern

```typescript
import * as p from '@clack/prompts';
```

### Session Management

```typescript
// Start session with styled header
p.intro(pc.bgCyan(pc.black(' my-tool ')));

// End session with message
p.outro(pc.green('Done!'));

// Cancel session (user pressed Ctrl+C)
p.cancel('Operation cancelled');
```

### Prompts

#### Text Input

```typescript
// Simple input
const name = await p.text({
  message: 'What is your name?',
  placeholder: 'Enter name...',
  defaultValue: 'Anonymous',
  validate: (value) => {
    if (!value) return 'Name is required';
    if (value.length < 2) return 'Name must be at least 2 characters';
  },
});

if (p.isCancel(name)) {
  p.cancel('Cancelled');
  process.exit(0);
}
```

#### Select (Single Choice)

```typescript
const choice = await p.select({
  message: 'Choose an option:',
  options: [
    { value: 'a', label: 'Option A', hint: 'The first option' },
    { value: 'b', label: 'Option B', hint: 'The second option' },
    { value: 'c', label: 'Option C' },
  ],
  initialValue: 'a',
});

if (p.isCancel(choice)) {
  p.cancel('Cancelled');
  process.exit(0);
}
```

#### Multiselect (Multiple Choices)

```typescript
const selected = await p.multiselect({
  message: `Select items ${pc.dim('(space to toggle)')}`,
  options: [
    { value: 'a', label: 'Item A' },
    { value: 'b', label: 'Item B' },
    { value: 'c', label: 'Item C' },
  ],
  initialValues: ['a'],
  required: true,
});

if (p.isCancel(selected)) {
  p.cancel('Cancelled');
  process.exit(0);
}
```

#### Confirm (Yes/No)

```typescript
const confirmed = await p.confirm({
  message: 'Are you sure?',
  initialValue: true,
});

if (p.isCancel(confirmed) || !confirmed) {
  p.cancel('Cancelled');
  process.exit(0);
}
```

#### Password

```typescript
const secret = await p.password({
  message: 'Enter your API key:',
  validate: (value) => {
    if (!value) return 'API key is required';
  },
});
```

### Spinner

```typescript
const spinner = p.spinner();

spinner.start('Loading data...');

// Do async work
await fetchData();

spinner.stop('Data loaded successfully');
// or on error:
spinner.stop(pc.red('Failed to load data'));
```

### Logging

```typescript
// Information
p.log.info('This is informational');

// Success
p.log.success('Operation completed');

// Warning
p.log.warn('This might cause issues');

// Error
p.log.error('Something went wrong');

// Generic message (no icon)
p.log.message('Additional details here');

// Step (numbered/bulleted)
p.log.step('Processing item 1');
```

### Note (Boxed Content)

```typescript
// Summary box
p.note(
  `${pc.cyan('skill-name')}\n` +
  `  ${pc.dim('symlink →')} Agent1, Agent2\n` +
  `  ${pc.yellow('overwrites:')} Agent3`,
  'Installation Summary'
);

// Or with pc.green title:
p.note(
  resultLines.join('\n'),
  pc.green('Installed 3 skills to 2 agents')
);
```

---

## Custom Color Constants

For consistent styling across the codebase, use these ANSI 256-color constants:

```typescript
// Color constants (put in src/utils/prompts/colors.ts)
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[38;5;102m';     // Darker gray for secondary text
export const TEXT = '\x1b[38;5;145m';    // Lighter gray for primary text
export const CYAN = '\x1b[36m';
export const MAGENTA = '\x1b[35m';
export const YELLOW = '\x1b[33m';

// Logo gradient (for ASCII art)
export const GRAYS = [
  '\x1b[38;5;250m',  // Lighter
  '\x1b[38;5;248m',
  '\x1b[38;5;245m',  // Mid
  '\x1b[38;5;243m',
  '\x1b[38;5;240m',
  '\x1b[38;5;238m',  // Darker
];

// Usage with raw ANSI (when pc doesn't suffice)
console.log(`${DIM}Secondary text${RESET}`);
console.log(`${TEXT}Primary text${RESET}`);
```

---

## Workflow Patterns

### Standard CLI Flow

```typescript
import * as p from '@clack/prompts';
import pc from 'picocolors';

async function main() {
  // 1. Show intro
  p.intro(pc.bgCyan(pc.black(' my-tool ')));

  // 2. Spinner for initial loading
  const spinner = p.spinner();
  spinner.start('Loading configuration...');
  const config = await loadConfig();
  spinner.stop('Configuration loaded');

  // 3. Show info
  p.log.info(`Found ${pc.cyan(config.items.length)} items`);

  // 4. Prompt for selection
  const selected = await p.select({
    message: 'Choose an action:',
    options: [
      { value: 'run', label: 'Run', hint: 'Execute the operation' },
      { value: 'dry', label: 'Dry run', hint: 'Preview changes only' },
    ],
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // 5. Confirmation before destructive action
  const confirmed = await p.confirm({
    message: 'Proceed with operation?',
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // 6. Execute with spinner
  spinner.start('Processing...');
  await doWork();
  spinner.stop('Processing complete');

  // 7. Show summary
  p.note(
    `Processed: ${pc.green('5')} items\n` +
    `Skipped: ${pc.yellow('2')} items`,
    pc.green('Summary')
  );

  // 8. Outro
  p.outro(pc.green('Done!'));
}
```

### Installation Flow (7-step pattern from vercel-skills)

```typescript
async function install() {
  p.intro(pc.bgCyan(pc.black(' installer ')));

  const spinner = p.spinner();

  // Step 1: Fetch metadata
  spinner.start('Fetching metadata...');
  const meta = await fetchMeta();
  spinner.stop(`Found ${pc.cyan(meta.name)}`);

  // Step 2: Show details
  p.log.info(`Package: ${pc.cyan(meta.name)}`);
  p.log.message(pc.dim(meta.description));

  // Step 3: Select items
  const items = await p.multiselect({
    message: `Select items ${pc.dim('(space to toggle)')}`,
    options: meta.items.map(i => ({
      value: i.id,
      label: i.name,
      hint: i.description,
    })),
  });

  if (p.isCancel(items)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // Step 4: Choose scope
  const scope = await p.select({
    message: 'Installation scope',
    options: [
      { value: 'local', label: 'Local', hint: 'Current project only' },
      { value: 'global', label: 'Global', hint: 'Available everywhere' },
    ],
  });

  if (p.isCancel(scope)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // Step 5: Choose method
  const method = await p.select({
    message: 'Installation method',
    options: [
      { value: 'symlink', label: 'Symlink (Recommended)', hint: 'Easy updates' },
      { value: 'copy', label: 'Copy', hint: 'Independent copies' },
    ],
  });

  if (p.isCancel(method)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // Step 6: Summary + confirmation
  p.note(
    `${pc.cyan(items.length)} items → ${scope}\n` +
    `Method: ${method}`,
    'Installation Summary'
  );

  const confirmed = await p.confirm({ message: 'Proceed?' });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  // Step 7: Execute
  spinner.start('Installing...');
  await doInstall();
  spinner.stop('Installation complete');

  p.note(
    items.map(i => `${pc.green('✓')} ${i}`).join('\n'),
    pc.green(`Installed ${items.length} items`)
  );

  p.outro(pc.green('Done!'));
}
```

---

## Error Handling

### Cancel Detection

```typescript
// Clack uses symbols for cancellation
const result = await p.select({ ... });

if (p.isCancel(result)) {
  p.cancel('Operation cancelled');
  process.exit(0);
}

// Type narrowing after check
const value = result as string;  // Now safe to use
```

### Error Display

```typescript
try {
  await riskyOperation();
} catch (error) {
  p.log.error(pc.red('Operation failed'));
  p.log.message(pc.dim(error instanceof Error ? error.message : 'Unknown error'));
  p.outro(pc.red('Failed'));
  process.exit(1);
}
```

### Validation in Prompts

```typescript
const value = await p.text({
  message: 'Enter URL:',
  validate: (input) => {
    if (!input) return 'URL is required';
    try {
      new URL(input);
    } catch {
      return 'Invalid URL format';
    }
  },
});
```

---

## Custom Components

### Search Multiselect (from vercel-skills)

For searchable multi-select with filtering, use the custom `searchMultiselect` component:

```typescript
// src/utils/prompts/clack/search-multiselect.ts
import * as readline from 'readline';
import { Writable } from 'stream';
import pc from 'picocolors';

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

// Symbols for consistent styling
const S_STEP_ACTIVE = pc.green('◆');
const S_STEP_CANCEL = pc.red('■');
const S_STEP_SUBMIT = pc.green('◇');
const S_RADIO_ACTIVE = pc.green('●');
const S_RADIO_INACTIVE = pc.dim('○');
const S_BAR = pc.dim('│');

export const cancelSymbol = Symbol('cancel');

export async function searchMultiselect<T>(
  options: SearchMultiselectOptions<T>
): Promise<T[] | symbol> {
  // Full implementation in src/utils/prompts/clack/search-multiselect.ts
  // See vercel-skills/src/prompts/search-multiselect.ts for reference
}
```

### Usage

```typescript
import { searchMultiselect, cancelSymbol } from '@/utils/prompts/clack';

const selected = await searchMultiselect({
  message: 'Select items to install',
  items: items.map(i => ({
    value: i.id,
    label: i.name,
    hint: i.description,
  })),
  initialSelected: ['item1'],
  maxVisible: 8,
});

if (selected === cancelSymbol) {
  p.cancel('Cancelled');
  process.exit(0);
}

// Use selected values
for (const id of selected as string[]) {
  console.log(id);
}
```

---

## Migration Checklist

For each file migrating from `@inquirer/prompts`:

- [ ] Replace import statements
- [ ] Replace `ExitPromptError` catch with `p.isCancel()` check
- [ ] Replace `chalk` with `pc` (picocolors)
- [ ] Replace `ora` spinner with `p.spinner()`
- [ ] Add `p.intro()` at start of main function
- [ ] Add `p.outro()` at end of main function
- [ ] Replace `console.log` info messages with `p.log.*`
- [ ] Add `p.cancel()` for user cancellation flows
- [ ] Use `p.note()` for summaries before confirmations
- [ ] Test keyboard navigation (up/down, space, enter, escape)

---

## Reference Files

- **vercel-skills CLI**: `vercel-skills/src/cli.ts` - Color constants, banner
- **vercel-skills add**: `vercel-skills/src/add.ts` - Full workflow example
- **Custom search-multiselect**: `vercel-skills/src/prompts/search-multiselect.ts`
