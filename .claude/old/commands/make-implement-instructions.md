# Make Implementation Instructions

Automatically generate implementation instruction files from task documentation files.

## Usage

```
/make-implement-instructions docs/tasks/2025-12/001-blacklist-subdomains.md
/make-implement-instructions docs/tasks/2025-12/*.md
```

## How It Works

1. Accepts one or more task markdown files (e.g., `001-blacklist-subdomains.md`)
2. Extracts task name and estimated effort
3. Generates corresponding `-Instructions.md` files with format:
   - Task Name
   - Branch Name (from filename number and slug)
   - Worktree Name (from filename slug)
   - Instructions (read main doc, implement, validate, PR)
4. Creates files in same directory as source files

## Example Output

For `001-blacklist-subdomains.md`:
- Creates `001-blacklist-subdomains-Instructions.md`
- Branch: `feature/001-blacklist-subdomains`
- Worktree: `ReservineBack-001-blacklist`
- Instructions reference the main task doc

## Implementation Steps

For each task file provided:
1. Extract task number and slug from filename
2. Read task file and extract:
   - Task summary from Executive Summary section
   - Estimated time from "Estimated Effort" or "Estimated Time"
3. Generate Instructions file with template:
   ```
   # Task #{number}: {slug-title} - Instructions

   **Task Name:** {extracted summary}
   **Branch Name:** `feature/{number}-{slug}`
   **Worktree Name:** `ReservineBack-{number}-{slug}`

   **Instructions:**
   1. Read `docs/tasks/2025-12/{original-filename}.md` for full implementation details
   2. Implement according to the phases in the task file
   3. Check PHPStan: `vendor/bin/phpstan analyze`
   4. Create GitHub PR: `gh pr create --title "{PR title}" --base feat/fixes --body "{PR description}"`

   **Estimated Time:** {extracted time}
   ```
4. Write file to same directory with `-Instructions.md` suffix
5. Report success/failure for each file
