# Recompose Git Commits

Analyze commits from a branch, filter by file patterns, and prepare cherry-pick commands.

## Arguments

- `$ARGUMENTS` - Optional: number of commits to analyze, source branch, target patterns (space-separated)

## Task

1. **Parse Arguments**
   - Number of commits (default: 50)
   - Source branch (default: current branch)
   - File patterns to filter (comma-separated, e.g., "src/claude-history/,plugins/,raycast/")

2. **Get Commit List with Files**
   ```bash
   git log --oneline -N <branch> --format="%h" --reverse | while read hash; do
     echo "=== $hash: $(git log -1 --format='%s' $hash) ==="
     git show --name-only --format= $hash
     echo ""
   done
   ```

3. **Save to File**
   Save the full commit list to `.claude/work/<branch>-commits.md`

4. **Filter Commits**
   Identify commits that touch the specified file patterns:
   ```bash
   git log --oneline -N <branch> --format="%h" --reverse | while read hash; do
     files=$(git show --name-only --format= $hash)
     if echo "$files" | grep -qE "<pattern1>|<pattern2>"; then
       echo "$hash $(git log -1 --format='%s' $hash)"
     fi
   done
   ```

5. **Identify Mixed Commits**
   For each matching commit, categorize files as:
   - **IN target**: Files matching the patterns
   - **OUTSIDE target**: Files NOT matching the patterns

6. **Generate Output**
   Present a table with:
   | # | Hash | Subject | Target Files | Mixed? |

7. **Ask User**
   - How to handle mixed commits (keep all, skip, reset outside files)
   - Which target patterns to include/exclude

8. **Generate Cherry-pick Command**
   ```bash
   git cherry-pick <hash1> <hash2> ...
   ```

9. **If Reset Needed**
   Generate command to reset outside files:
   ```bash
   git checkout <base-branch> -- <file1> <file2> ...
   ```

## Example Usage

```
/recompose-git-commits 78 feat/next src/claude-history/,plugins/,raycast/
```

This will:
1. Analyze 78 commits from feat/next
2. Find commits touching claude-history, plugins, or raycast directories
3. Show you the filtered commits
4. Ask how to proceed
5. Generate the cherry-pick commands
