# Clack Prompts Documentation & Migration Plan

## Goal

Create comprehensive documentation for `@clack/prompts` with `picocolors` usage patterns (inspired by vercel-skills), then write a detailed migration plan for all GenesisTools that use `@inquirer/prompts`.

**Note:** Both libraries will coexist - this is a gradual migration with clear guidance on when to use each.

## Deliverables Created

### 1. Documentation: `docs/prompts-and-colors.md`
Comprehensive guide covering:
- Why migrate from @inquirer to @clack
- Picocolors API and composing styles
- Clack prompts full API (text, select, multiselect, confirm, password, spinner, logging)
- Custom color constants (ANSI 256-color codes from vercel-skills)
- Standard workflow patterns (7-step installation flow)
- Error handling with `p.isCancel()`
- Custom searchMultiselect component
- Migration checklist

### 2. Migration Plan: `docs/plans/2026-01-31-clack-prompts-migration.md`
Agent-orchestration-ready plan with:
- 31 tasks organized into waves for parallel execution
- Wave 1: Foundation (install deps, create shared utilities, update docs)
- Wave 2: Core tool migrations (3 agents can work in parallel)
- Wave 3: Finalization (testing, final commits)

Each task includes:
- Exact file paths to modify/create
- Code snippets for changes
- Test commands with expected output
- Commit commands

### Files Requiring Migration (28 total)

| Complexity | Files |
|------------|-------|
| High (3) | azure-devops/index.ts, mcp-manager/commands/rename.ts, git-rebase-multiple/prompts.ts |
| Medium (12) | mcp-manager/index.ts, github/index.ts, git-last-commits-diff, ask/*, timely/login, rename-commits, claude-history, etc. |
| Low (13) | tools, git-commit, watchman, macos-eslogger, timely/*, mcp-manager/utils/*, etc. |

### Prompt Mapping

| @inquirer | @clack | Notes |
|-----------|--------|-------|
| input | p.text | - |
| select | p.select | - |
| confirm | p.confirm | - |
| checkbox | p.multiselect | Add "(space to toggle)" hint |
| search | custom searchMultiselect | Copied from vercel-skills |
| password | p.password | - |
| editor | N/A | Keep inquirer or use external |
| number | p.text + validate | - |
| ExitPromptError catch | p.isCancel() check | After each prompt |

### Shared Utilities to Create

```
src/utils/prompts/
├── index.ts              # Main barrel export (shared only)
├── colors.ts             # Shared ANSI codes, pc re-export, styled helpers
├── inquirer/
│   ├── index.ts          # Barrel export for inquirer utils
│   └── helpers.ts        # ExitPromptError handling, wrappers
└── clack/
    ├── index.ts          # Barrel export for clack utils
    ├── helpers.ts        # withCancel, handleCancel, multiselect wrapper
    └── search-multiselect.ts  # Custom searchable multi-select component
```

## Important Note

**Keep both libraries installed:** This is a gradual migration. We keep `@inquirer/prompts` alongside `@clack/prompts`:
- `@inquirer/prompts` remains for tools not yet migrated and for `editor` prompt (no clack equivalent)
- `@clack/prompts` for newly migrated tools
- No forced removal of old dependencies

---

## Documentation Updates Required

### 1. Update `CLAUDE.md`

Add section "When to Use Which Prompt Library" after the existing template:

```markdown
### Choosing a Prompt Library

We support two prompt libraries. Choose based on your needs:

| Use Case | Library | Why |
|----------|---------|-----|
| New tools with multi-step flows | `@clack/prompts` | Beautiful spinners, intro/outro, structured logging |
| Tools needing `editor` prompt | `@inquirer/prompts` | No clack equivalent |
| Tools needing `search` with filtering | Either | Use custom `searchMultiselect` with clack |
| Existing tools being modified | Keep current | Don't mix in same file |
| Simple single-prompt scripts | Either | Personal preference |
```

Also add a second template using `@clack/prompts` pattern.

### 2. Update `.claude/docs/testing.md`

Add section for testing `@clack/prompts`:

```markdown
## Testing @clack/prompts

Unlike @inquirer/prompts, clack prompts return `symbol` on cancel (checked via `p.isCancel()`).

### Mocking Pattern

\`\`\`typescript
import { mock } from "bun:test";

// Mock before imports
mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  spinner: () => ({ start: () => {}, stop: () => {} }),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  select: async () => mockResponses.select,
  confirm: async () => mockResponses.confirm,
  text: async () => mockResponses.text,
  multiselect: async () => mockResponses.multiselect,
  log: { info: () => {}, error: () => {}, warn: () => {}, message: () => {}, step: () => {} },
  note: () => {},
}));

// For cancel testing
setMockResponses({ select: Symbol.for('cancel') });
\`\`\`
```

### 3. `docs/prompts-and-colors.md` (Already Updated)

This file was created and already includes the "When to Use Which" section:

```markdown
## When to Use Which Library

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
```

---

## Verification

After implementation:
1. `bun run tsgo --noEmit` - No type errors
2. Test each tool interactively for proper UX
