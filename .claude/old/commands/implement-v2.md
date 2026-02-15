# Implement Task (v2) - Unified Cross-Environment

Execute implementation workflow for a task. Works in all environments:
- Main repository (creates branch from dev)
- Claude Desktop worktree (creates branch from current HEAD)
- Claude Code web/cloud (uses existing setup)

## Usage

```text
/implement-v2 <plan-name> [--base=<branch>] [--no-vendor-link]
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `<plan-name>` | (required) | Partial or full name to search in `.claude/plans/` |
| `--base=<branch>` | `dev` | Target branch for PR |
| `--no-vendor-link` | false | Run composer install instead of symlink |

## Examples

```bash
/implement-v2 NewSettingsForBE
/implement-v2 DownloadableInvoices --base=master
/implement-v2 MyFeature --no-vendor-link
```

---

## Workflow

### Step 1: Run setup-worktree.sh

The `setup-worktree.sh` script handles **everything**. Just run it with the plan name:

```bash
./setup-worktree.sh --plan=<plan-name> [--base=dev] [--skip-sail]
```

The script will automatically:
- Search `.claude/plans/` for matching plan file
- Extract branch name from the plan filename
- Auto-detect `ROOT_WORKTREE_PATH` from git worktree list
- Detect environment (cloud/worktree/main repo)
- Verify git is clean
- Create and checkout branch
- Copy .env files from main repo
- Setup vendor (symlink by default)
- Provide audio notification when complete

**Example for `/implement-v2 NewSettingsForBE --base=dev`:**

```bash
./setup-worktree.sh --plan=NewSettingsForBE --base=dev --skip-sail
```

### Step 2: Verify Setup

```bash
# Verify we're on correct branch
git branch --show-current

# Verify PHPStan works via symlink
vendor/bin/phpstan analyze --version
```

### Step 3: Implement

1. Read the plan file found by setup-worktree.sh
2. Follow implementation phases
3. Commit in logical chunks (not one giant commit)

### Step 4: Validate

```bash
vendor/bin/phpstan analyze <modified-files>
```

### Step 5: Create PR

```bash
gh pr create \
  --title "feat(<scope>): <task-summary>" \
  --base <base-branch> \
  --body "$(cat <planfile>)"
```

---

## Service Locality Warning

In worktree/local environments, commands use **SHARED** local services:

| Command | What it uses |
|---------|--------------|
| `sail a` / `php artisan` | Same database, redis, meilisearch |
| `sail test` | Shared test database |

**Safe cross-worktree tools:**
- PHPStan: `vendor/bin/phpstan analyze` (via symlink)

---

## Branch Naming

Branch = plan filename without `.md`:
- `2025-12-30-MyFeature.md` → branch `2025-12-30-MyFeature`
- `2025-12-26-NewSettingsForBE.FE.md` → branch `2025-12-26-NewSettingsForBE.FE`

---

## Differences from /implement

| Feature | /implement | /implement-v2 |
|---------|-----------|---------------|
| Setup | Manual steps | Single `./setup-worktree.sh` call |
| ROOT_WORKTREE_PATH | Required | Auto-detected |
| Plan search | Manual | `--plan=` searches .claude/plans/ |
| Branch naming | `auto-claude/...` prefix | Plan filename directly |
| Vendor handling | Full install | Symlink by default |
| Audio notification | None | sayy on completion |
