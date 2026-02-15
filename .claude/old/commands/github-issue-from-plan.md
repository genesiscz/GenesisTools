# GitHub Issue from Plan

Create GitHub issues from plan files in `.claude/plans/` directory.

## Usage

```bash
/github-issue-from-plan <plan-name> [--be] [--fe]
```

## Arguments

- `<plan-name>`: Name of the plan file (with or without date prefix, with or without .md extension)
  - Examples: `TranslationData`, `2025-12-30-TranslationData`, `TranslationData.md`
- `--be`: Create backend issue on genesiscz/ReservineBack
- `--fe`: Create frontend issue on LEFTEQ/reservine

**Note:** If neither `--be` nor `--fe` is specified, both will be created.

## Examples

```bash
# Create both BE and FE issues
/github-issue-from-plan TranslationData

# Create only BE issue
/github-issue-from-plan TranslationData --be

# Create only FE issue
/github-issue-from-plan TranslationData --fe

# Works with full filename
/github-issue-from-plan 2025-12-30-TranslationData.md --be --fe
```

**Or run the script directly:**

```bash
bun scripts/GithubIssueFromPlan.ts TranslationData
bun scripts/GithubIssueFromPlan.ts SmartLock --be
bun scripts/GithubIssueFromPlan.ts TenantDomains --fe
```

## Plan File Structure

The command looks for plan files matching this pattern:
- `.claude/plans/<date>-<plan-name>.md` - Backend plan
- `.claude/plans/<date>-<plan-name>.FE.md` - Frontend plan (optional)

## Behavior

### If only BE file exists:
- `--be` or no flags: Creates issue on genesiscz/ReservineBack with BE content
- `--fe`: Shows warning that FE file doesn't exist

### If both BE and FE files exist:
- `--be`: Creates issue on genesiscz/ReservineBack with "# BE" + "# FE" sections
- `--fe`: Creates issue on LEFTEQ/reservine with FE content only
- No flags or both flags: Creates both issues
  - BE issue is created first
  - FE issue includes a reference link to the BE issue at the top of the description

### Issue Titles:
- BE issue: Extracted from first `# ` heading in BE file
- FE issue: `[FE] ` + extracted title from FE file

## Implementation

The command executes the TypeScript script at `scripts/GithubIssueFromPlan.ts`:

```bash
bun scripts/GithubIssueFromPlan.ts <plan-name> [--be] [--fe]
```

The script performs the following steps:

1. **Find the plan file(s)**:
   - Search `.claude/plans/` for files matching the plan name
   - Support partial name matching (e.g., "Translation" matches "2025-12-30-TranslationData.md")
   - Find both BE and FE files if they exist

2. **Extract title**:
   - Read first line starting with `# ` from the plan file
   - Use that as the GitHub issue title

3. **Create issues**:
   - BE issue: Full BE content + "# FE" section (if FE file exists) + source file references at the end
   - FE issue: FE content with `[FE]` prefix in title + source file reference at the end
     - If both BE and FE issues are being created, the FE issue will include a reference link to the BE issue at the top
   - Use temp files to handle large content

4. **Output**:
   - Print GitHub issue URLs for created issues
   - Show any errors or warnings

## Error Handling

- **Plan file not found**: Show error with available plans
- **No GitHub CLI**: Show error to install `gh`
- **Authentication error**: Show error to run `gh auth login`
- **File too large**: Automatically use temp file approach

## Example Output

When creating both BE and FE issues, the FE issue will have this format:

```markdown
> **Related Backend Issue:** https://github.com/genesiscz/ReservineBack/issues/128

---

[FE plan content here...]

---

> **Source Plan Files:**
> - FE: [`2025-12-30-TranslationData.FE.md`](https://github.com/genesiscz/ReservineBack/blob/master/.claude/plans/2025-12-30-TranslationData.FE.md)
```

The BE issue will include links to both BE and FE plan files:

```markdown
# BE

[BE plan content here...]

# FE

[FE plan content here...]

---

> **Source Plan Files:**
> - BE: [`2025-12-30-TranslationData.md`](https://github.com/genesiscz/ReservineBack/blob/master/.claude/plans/2025-12-30-TranslationData.md)
> - FE: [`2025-12-30-TranslationData.FE.md`](https://github.com/genesiscz/ReservineBack/blob/master/.claude/plans/2025-12-30-TranslationData.FE.md)
```

This creates clear links between:
- Backend and frontend implementation tasks (via the related issue reference)
- Issues and their source plan files (via the source plan files footer)

## Notes

- The command uses `gh issue create` which requires GitHub CLI to be installed and authenticated
- Large plan files (>10KB) are automatically written to temp files before creating issues
- When both BE and FE issues are created, they are linked together via a reference at the top of the FE issue
- BE issues are always created first to ensure the URL is available for the FE issue reference
- All issues include a footer with links to the source plan file(s) in the repository
