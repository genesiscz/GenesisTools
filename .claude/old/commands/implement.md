# Implement Task

Execute the implementation workflow for a task using its instruction file.

## Usage

```
/implement docs/tasks/2025-12/001-blacklist-subdomains-Instructions.md
/implement 001
```

Search in

- .claude/plans/
- docs/tasks/<name> (recursively but only if not found in the first one)

## How It Works

1. Reads the instruction file (or searches for it by task number)
2. Extracts:
   - Task Name
   - Main task documentation file path
3. Executes workflow:
   - Reads main task documentation file
   - Implements according to task details
   - Validates with PHPStan (only files you modified/created)
   - Commits (can be multiple) in logical chunks.
   - Creates GitHub PR with proper title/description

## Workflow Steps

0. If you are on a worktree, make sure it is based on the "dev" branch. Create a branch with the name of the task <datetime>-
1. **Parse Instructions File**
   - Extract task name, branch name, task doc path
   - Validate all required fields present

2. **Read Task Documentation**
   - Load and display main task markdown file
   - Extract implementation phases and checklist

3. **Implement**
   - Follow phase-by-phase implementation from task doc
   - Create files as specified
   - Update existing files as needed
   - Track progress in checklist

4. **Validate with PHPStan**

   ```bash
   vendor/bin/phpstan analyze
   ```

5. **Create GitHub PR**
   - Extract PR title from instructions
   - Extract PR description from task doc
   - Use gh CLI to create PR targeting dev
   ```bash
   gh pr create --title "..." --base dev --body-file "<planfilepath>"
   ```

## Example

```
/implement 001
```

This will:

1. Find `001-blacklist-subdomains-Instructions.md`
2. Read `docs/tasks/2025-12/001-blacklist-subdomains.md`
3. Implement all 6 phases
4. Validate with PHPStan
5. Create PR targeting dev

## Requirements

- Instructions file must exist (or be found by task number)
- Already in feature branch with worktree created
- gh CLI must be installed and authenticated
- All tools must be available (php, composer, etc.)
