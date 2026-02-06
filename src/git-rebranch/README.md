# ✂️ Git Rebranch

> Split a messy branch with mixed commits into multiple clean, focused branches.

A tool for when you've been committing to a single branch but the work really belongs on 2-3 separate branches. It parses your conventional commits, groups them by scope/ticket, and creates new branches via cherry-pick from the fork point.

---

## ✨ Features

-   🔍 **Auto-detection** - Finds fork point and base branch automatically
-   🏷️ **Smart grouping** - Groups commits by scope, ticket ID (COL-123, PROJ-456)
-   🔎 **Searchable multiselect** - Refine groups with search and toggle
-   🌳 **Cherry-pick execution** - Creates branches from fork point, cherry-picks commits
-   🔄 **Flexible assignment** - Exclusive or shared commit mode (one branch or many)
-   📋 **Dry run** - Preview execution plan without creating branches
-   ⚠️ **Conflict handling** - Skips conflicting cherry-picks with warnings

---

## 🚀 Quick Start

```bash
# Interactive mode (recommended)
tools git-rebranch

# Preview without creating branches
tools git-rebranch --dry-run

# Show git commands being executed
tools git-rebranch --verbose
```

---

## 📋 Usage

### Workflow

1. **Select source branch** - Defaults to current branch
2. **Confirm base branch** - Auto-detected fork point (e.g., `master`)
3. **Review commit groups** - Auto-grouped by scope/ticket
4. **Choose exclusivity** - Can commits appear in multiple branches?
5. **Refine groups** - Searchable multiselect for each group
6. **Name branches** - Suggested from group labels
7. **Review & confirm** - See execution plan before changes
8. **Execute** - Creates branches and cherry-picks commits

### Commit Grouping Heuristic

Commits are grouped using conventional commit format parsing:

```
feat(login, COL-123): add login form      → Group: "login - COL-123"
fix(login, COL-123): fix validation        → Group: "login - COL-123"
feat(dashboard, COL-321): add chart        → Group: "dashboard - COL-321"
chore(dashboard, COL-321): cleanup         → Group: "dashboard - COL-321"
update README                              → Group: "Ungrouped commits"
```

Ticket IDs (e.g., `COL-123`, `PROJ-456`) are extracted from both scope and message body.

---

## ⚙️ Options

| Option          | Alias | Description                               |
| --------------- | ----- | ----------------------------------------- |
| `--dry-run`     |       | Show execution plan without creating branches |
| `--verbose`     | `-v`  | Show git commands being executed          |
| `--help-full`   | `-?`  | Show detailed help message                |

---

## ⚠️ Important Notes

### Cherry-Pick Behavior

-   ⚠️ **Conflicts are skipped** - If a cherry-pick conflicts, the commit is skipped and a warning is shown
-   🔄 **Order preserved** - Commits are cherry-picked in their original order (oldest first)
-   💾 **Original branch untouched** - The source branch is not modified

### Preconditions

The tool will refuse to run if:
-   Working tree has uncommitted changes
-   A rebase is in progress
-   Git repository is locked (`.git/index.lock`)
-   HEAD is detached

---

## 🎯 Examples

```bash
# Split current branch into separate feature branches
tools git-rebranch

# Preview what would happen
tools git-rebranch --dry-run

# See all git commands
tools git-rebranch --verbose

# Show detailed help
tools git-rebranch --help-full

# Show this README
tools git-rebranch --readme
```

---

## 💡 Tips

-   **Start with `--dry-run`** to preview the execution plan before creating branches
-   **Use conventional commits** for best grouping results (`feat(scope): message`)
-   **Include ticket IDs** in your commit scopes for automatic grouping
-   **Use exclusive mode** (default) unless you intentionally need commits on multiple branches
-   **Check branch names** before confirming - suggested names may need adjustment

---

## 🔧 Technical Details

-   Uses `git merge-base` to detect fork points
-   Parses conventional commits with regex: `type(scope)!: message`
-   Extracts ticket IDs matching `[A-Z]{2,10}-\d+` pattern
-   Creates branches with `git checkout -b <name> <fork-point>`
-   Cherry-picks with automatic conflict abort and skip
-   Returns to original branch after completion

---

## 🐛 Troubleshooting

### "Could not detect a fork point"

Make sure your branch was created from another branch (e.g., `master`). The tool needs at least one other branch to find the merge-base.

### Cherry-pick conflicts

Conflicting commits are skipped automatically. After the tool completes, you can manually cherry-pick the skipped commits:

```bash
git checkout <new-branch>
git cherry-pick <commit-hash>
# Resolve conflicts, then:
git cherry-pick --continue
```

### Unexpected grouping

If commits aren't grouping as expected, ensure they follow conventional commit format:

```
feat(scope, TICKET-123): your message
```

Non-conventional commits will be placed in the "Ungrouped" group.
