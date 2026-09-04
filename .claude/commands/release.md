---
name: release
description: Generate a new CHANGELOG.md entry from git commits since last release
allowed-tools:
    - Bash
    - Read
    - Write
    - Edit
    - Grep
    - Glob
---

# Release: Generate Changelog Entry

Generate a new release entry in CHANGELOG.md based on git commits since the last release.

## Version Format

Versions use: `YYYY.MM.DD.revision` (e.g., `2026.02.18.1`)

- Year.Month.Day of the release
- Revision starts at 1 and increments if multiple releases on the same day

## Workflow

### Step 1: Read current CHANGELOG.md

Read `CHANGELOG.md` in the project root. If it doesn't exist, create it with this header:

```
# Changelog

All notable changes to GenesisTools will be documented in this file.

Version format: `YYYY.MM.DD.revision` (e.g., `2026.02.18.1`)
```

### Step 2: Determine version

- Get today's date for the version prefix (YYYY.MM.DD)
- Check if a version with today's date already exists in CHANGELOG.md
- If yes, increment the revision number. If no, use revision `.1`

### Step 3: Find commits since last release

Find the last version header in CHANGELOG.md (e.g., `## 2026.02.17.1`). Get all commits on master since that version was created:

```bash
# Get the date of the last changelog entry commit, then find commits since
git log master --oneline --since="<date-of-last-entry>"
```

If there's no previous version in CHANGELOG.md, use the last 50 commits:
```bash
git log master --oneline -50
```

### Step 4: Analyze commits

For each commit (or group of related commits), look at the actual diff to understand what changed:

```bash
git diff <commit>^..<commit> --stat
git diff <commit>^..<commit>
```

Group changes by tool/component name. Use the directory name under `src/` as the grouping key.

### Step 5: Generate changelog entry

Write the entry at the TOP of the changelog (after the header). Format:

```markdown
## YYYY.MM.DD.revision

### ToolName
- Brief description of what changed and why
- Another change

### AnotherTool
- Change description

### Core / Utils
- Changes to shared utilities or infrastructure
```

**Guidelines:**
- Write in past tense ("Added", "Fixed", "Improved", "Removed")
- Focus on user-visible changes, not internal refactors (unless significant)
- Each bullet should be a single concise sentence
- Group related commits into single bullets where appropriate
- Prefix with: Added, Fixed, Improved, Removed, Changed, Updated
- Skip merge commits and trivial changes (typos, formatting)

### Step 6: Commit the changelog

```bash
git add CHANGELOG.md
git commit -m "chore(release): YYYY.MM.DD.revision"
```
