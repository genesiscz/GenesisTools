# Azure DevOps CLI Refactoring Plan

## Summary

Refactor `src/azure-devops/index.ts` (1789 lines) into modular command files using Commander subcommands pattern for better maintainability and to prepare for TimeLog feature addition.

## Current State

**Single monolithic file:** `src/azure-devops/index.ts` (1789 lines)

Contains:
- Configuration commands
- Query management
- Work item operations
- Dashboard operations
- Work item creation wizard
- Output formatting
- All CLI option parsing

## Target Structure

```
src/azure-devops/
├── index.ts                    # Main CLI entry, registers subcommands
├── api.ts                      # API wrapper (unchanged)
├── types.ts                    # TypeScript types (extend as needed)
├── utils.ts                    # Shared utilities (unchanged)
├── cli.utils.ts                # CLI error messages (unchanged)
├── commands/
│   ├── index.ts                # Exports all commands
│   ├── configure.ts            # --configure <url> - set organization/project
│   ├── query.ts                # --query <id> - run queries, download results
│   ├── workitem.ts             # --workitem <id> - fetch/display work items
│   ├── workitem-create.ts      # --create - work item creation wizard
│   ├── workitem-cache.ts       # --list - list cached work items
│   ├── dashboard.ts            # --dashboard <id> - dashboard queries
│   └── timelog.ts              # timelog add|list|types|import
└── README.md                   # Documentation
```

## Implementation Plan

### Phase 1: Create Commands Directory Structure

1. Create `src/azure-devops/commands/` directory
2. Create `src/azure-devops/commands/index.ts` barrel file

### Phase 2: Extract Configure Command

**File:** `src/azure-devops/commands/configure.ts`

Extract:
- `--configure <url>` handling
- Config file creation/update
- Project ID fetching
- `az devops configure` integration

### Phase 3: Extract Query Command

**File:** `src/azure-devops/commands/query.ts`

Extract:
- `--query <url|id|name>` handling
- Query result processing
- Change detection logic
- State/severity filtering
- Download work items functionality

### Phase 4: Extract Workitem Command

**File:** `src/azure-devops/commands/workitem.ts`

Extract:
- `--workitem <id|url|ids>` handling
- Work item fetching and caching
- Markdown generation
- Category/task folder management

### Phase 5: Extract Dashboard Command

**File:** `src/azure-devops/commands/dashboard.ts`

Extract:
- `--dashboard <url|id>` handling
- Dashboard query listing

### Phase 6: Extract Workitem Create Command

**File:** `src/azure-devops/commands/workitem-create.ts`

Extract:
- `--create` handling
- Interactive work item creation wizard (9-step wizard)
- Template handling (WorkItemTemplate)
- From-file, from-query, from-workitem modes
- Field suggestions and hints

### Phase 7: Extract Workitem Cache Command

**File:** `src/azure-devops/commands/workitem-cache.ts`

Extract:
- `--list` handling
- Display cached work items with state and fetch time
- Indicate which have associated task files

### Phase 8: Update Main Entry Point

**File:** `src/azure-devops/index.ts`

Simplify to:
- Program setup
- Register all subcommands from `./commands/`
- Shared setup (config loading, etc.)

### Phase 9: Prepare for TimeLog

Create placeholder:
**File:** `src/azure-devops/commands/timelog.ts`

```typescript
import { Command } from 'commander';

function showHelpFull(): void {
  console.log(`
Usage: tools azure-devops timelog <command> [options]

Commands:
  add      Add a time log entry to a work item
  list     List time logs for a work item
  types    List available time types
  import   Import time logs from JSON file

Examples:
  tools azure-devops timelog add --workitem 268935 --hours 2 --type "Development"
  tools azure-devops timelog add --workitem 268935 --hours 1 --minutes 30 --type "Code Review" --comment "PR review"
  tools azure-devops timelog add --workitem 268935 --interactive
  tools azure-devops timelog list --workitem 268935
  tools azure-devops timelog types
  tools azure-devops timelog import entries.json

Available Time Types (run 'timelog types' for full list):
  Development, Code Review, Business Analýza, IT Analýza, Test,
  Dokumentace, Ceremonie, Konfigurace, Release, UX, ...

Hours/Minutes:
  --hours 2              → 120 minutes
  --hours 1 --minutes 30 → 90 minutes
  --minutes 30           → ERROR (use --hours 0 --minutes 30)
  --hours 0 --minutes 30 → 30 minutes
`);
}

export function registerTimelogCommand(program: Command): void {
  const timelog = program
    .command('timelog')
    .description('Manage time log entries')
    .option('-?, --help-full', 'Show detailed help')
    .action((options) => {
      if (options.helpFull) {
        showHelpFull();
        process.exit(0);
      }
    });

  timelog
    .command('add')
    .description('Add a time log entry')
    .option('-w, --workitem <id>', 'Work item ID')
    .option('-h, --hours <hours>', 'Hours to log')
    .option('-m, --minutes <minutes>', 'Additional minutes (requires --hours)')
    .option('-t, --type <type>', 'Time type (e.g., "Development")')
    .option('-d, --date <date>', 'Date (YYYY-MM-DD, default: today)')
    .option('-c, --comment <text>', 'Comment/description')
    .option('-i, --interactive', 'Interactive mode with prompts')
    .option('-?, --help-full', 'Show detailed help')
    .action(async (options) => {
      // TODO: Implement after refactor
      console.log('TimeLog add - to be implemented');
    });

  timelog
    .command('list')
    .description('List time logs for a work item')
    .requiredOption('-w, --workitem <id>', 'Work item ID')
    .action(async (options) => {
      console.log('TimeLog list - to be implemented');
    });

  timelog
    .command('types')
    .description('List available time types')
    .action(async () => {
      console.log('TimeLog types - to be implemented');
    });

  timelog
    .command('import')
    .description('Import time logs from JSON file')
    .argument('<file>', 'JSON file path')
    .action(async (file) => {
      console.log('TimeLog import - to be implemented');
    });
}
```

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `src/azure-devops/index.ts` | Simplify | Main entry, register commands (~100 lines) |
| `src/azure-devops/commands/index.ts` | Create | Barrel file, export all commands |
| `src/azure-devops/commands/configure.ts` | Create | `--configure <url>` - org/project setup |
| `src/azure-devops/commands/query.ts` | Create | `--query <id>` - run queries, changes detection |
| `src/azure-devops/commands/workitem.ts` | Create | `--workitem <id>` - fetch/display work items |
| `src/azure-devops/commands/workitem-create.ts` | Create | `--create` - work item creation wizard |
| `src/azure-devops/commands/workitem-cache.ts` | Create | `--list` - list cached work items |
| `src/azure-devops/commands/dashboard.ts` | Create | `--dashboard <id>` - dashboard queries |
| `src/azure-devops/commands/timelog.ts` | Create | `timelog add|list|types|import` (placeholder) |

## Shared Dependencies

Commands will import from:
- `../api.ts` - Api class
- `../types.ts` - TypeScript interfaces
- `../utils.ts` - Utility functions (formatters, file helpers)
- `../cli.utils.ts` - Error messages

## Verification Plan

1. Run `tools azure-devops --help` - Should show all commands
2. Test `tools azure-devops --configure <url>` - Config flow
3. Test `tools azure-devops --query <id>` - Query results
4. Test `tools azure-devops --workitem <id>` - Work item fetch
5. Test `tools azure-devops --create -i` - Creation wizard
6. Test `tools azure-devops --list` - Cached items
7. Test `tools azure-devops timelog --help` - New timelog help

## Next Steps After Refactor

After this refactor is complete, implement TimeLog functionality by:
1. Running `superpowers:write-plan` to create detailed TimeLog implementation plan
2. Implementing `timelog-api.ts`
3. Filling in `commands/timelog.ts` subcommands
4. Adding interactive prompts (clack + inquirer versions)

## Status

**READY FOR IMPLEMENTATION**
