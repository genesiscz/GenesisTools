# git-rebase-multiple

Safe branch hierarchy rebasing with full rollback capability.

## Problem

When rebasing a parent branch (e.g., `feature` onto `main`):
1. All commit SHAs change
2. Child branches still point to old commits
3. Rebasing children causes duplicate commits and conflicts
4. Manual tracking of fork points is error-prone

## Solution

An interactive tool that:
1. Tracks fork points BEFORE rebasing parent
2. Creates backup refs for all branches
3. Guides you step-by-step through rebasing
4. Uses `--onto` with saved fork points for children
5. Allows abort/restore at ANY point

## Usage

```bash
# Interactive mode (recommended)
tools git-rebase-multiple

# Show current state and backups
tools git-rebase-multiple --status

# Preview execution plan without making changes
tools git-rebase-multiple --dry-run

# Abort and restore all branches
tools git-rebase-multiple --abort

# Continue after resolving conflicts
tools git-rebase-multiple --continue

# Remove backup refs and fork tags
tools git-rebase-multiple --cleanup

# Restore a single branch from backup
tools git-rebase-multiple --restore <branch>
```

## Interactive Flow

```text
$ tools git-rebase-multiple

📋 Git Rebase Multiple - Safe Branch Hierarchy Rebasing

? Which branch do you want to rebase?
> feature-parent

? Onto which branch?
> main

Found 2 branches that may depend on feature-parent:
  [x] child-1 (5 commits ahead)
  [x] child-2 (3 commits ahead)

📝 Execution Plan:

  Step 1: Create backup refs
  Step 2: Save fork points for each child
  Step 3: Rebase feature-parent onto main
  Step 4: Rebase child-1 onto new feature-parent
  Step 5: Rebase child-2 onto new feature-parent
  Step 6: Cleanup (optional)

⚠️  You can abort at ANY step with: tools git-rebase-multiple --abort
```

## Safety Features

### Backup Refs
- Created at `refs/backup/grm/<branch-name>`
- Stores original HEAD of each branch
- Survives git gc (unlike reflogs)

### Fork Point Tags
- Created at `fork/<child-branch>`
- Stores merge-base between parent and child
- Used for accurate `--onto` rebasing

### State File
- Location: `.git/rebase-multiple-state.json`
- Tracks operation progress
- Enables resume after conflicts

## Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--help-full` | `-?` | Show detailed help message |
| `--abort` | `-a` | Abort and restore all branches |
| `--continue` | `-c` | Continue after resolving conflicts |
| `--status` | `-s` | Show current state and backups |
| `--cleanup` | | Remove all backup refs and fork tags |
| `--restore [branch]` | `-r` | Restore single branch from backup |
| `--dry-run` | | Show execution plan without running |
| `--parent <branch>` | | Parent branch to rebase (non-interactive) |
| `--target <branch>` | | Target branch to rebase onto (non-interactive) |
| `--children <branches>` | | Comma-separated child branches (non-interactive) |

## Non-Interactive Mode

```bash
tools git-rebase-multiple \
  --parent feature-branch \
  --target main \
  --children child-1,child-2
```

## Example Scenario

```text
Before:
  main:     A---B---C---D
                 \
  feature:        E---F
                       \
  child-1:              G---H
                       \
  child-2:              I

After rebasing feature onto main (with children):
  main:     A---B---C---D
                         \
  feature:                E'--F'
                               \
  child-1:                      G'--H'
                               \
  child-2:                      I'
```

## Conflict Resolution

If conflicts occur during any rebase:

1. Resolve conflicts in your editor
2. Stage changes: `git add .`
3. Continue the rebase: `git rebase --continue`
4. Resume the tool: `tools git-rebase-multiple --continue`

Or abort everything: `tools git-rebase-multiple --abort`

## Architecture

```text
src/git-rebase-multiple/
├── index.ts      # Main CLI orchestration
├── types.ts      # TypeScript interfaces
├── git.ts        # Git command wrapper
├── backup.ts     # Backup manager
├── forkpoint.ts  # Fork point manager
├── state.ts      # State persistence
└── prompts.ts    # Interactive prompts
```
