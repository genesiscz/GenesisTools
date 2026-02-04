# az repos pr

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage pull requests in Azure Repos.

## Commands Overview

| Command | Description |
|---------|-------------|
| `az repos pr create` | Create a pull request |
| `az repos pr list` | List pull requests |
| `az repos pr show` | Get PR details |
| `az repos pr update` | Update PR (title, description, status) |
| `az repos pr checkout` | Checkout PR branch locally |
| `az repos pr set-vote` | Vote on a PR |
| `az repos pr reviewer add` | Add reviewers |
| `az repos pr reviewer list` | List reviewers |
| `az repos pr reviewer remove` | Remove reviewers |
| `az repos pr policy list` | List PR policies |
| `az repos pr policy queue` | Re-queue policy evaluation |
| `az repos pr work-item add` | Link work items |
| `az repos pr work-item list` | List linked work items |
| `az repos pr work-item remove` | Unlink work items |

---

## az repos pr create

Create a new pull request.

```bash
az repos pr create [--title <TITLE>]
                   [--description <DESC>]
                   [--source-branch <BRANCH>]
                   [--target-branch <BRANCH>]
                   [--repository <REPO>]
                   [--reviewers <USERS>]
                   [--required-reviewers <USERS>]
                   [--work-items <IDS>]
                   [--labels <LABELS>]
                   [--draft {true, false}]
                   [--auto-complete {true, false}]
                   [--squash {true, false}]
                   [--delete-source-branch {true, false}]
                   [--merge-commit-message <MSG>]
                   [--transition-work-items {true, false}]
                   [--bypass-policy {true, false}]
                   [--bypass-policy-reason <REASON>]
                   [--open]
                   [--org <URL>]
                   [--project <NAME>]
                   [--detect {true, false}]
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--title` | - | PR title |
| `--description, -d` | - | PR description (markdown). Multiple values = multiple lines |
| `--source-branch, -s` | Current branch | Source branch name (e.g., `dev`, `feature/x`) |
| `--target-branch, -t` | Default branch | Target branch name |
| `--repository, -r` | Current repo | Repository name or ID |
| `--reviewers` | - | Optional reviewers (space-separated) |
| `--required-reviewers` | - | Required reviewers (space-separated) |
| `--work-items` | - | Work item IDs to link (space-separated) |
| `--labels` | - | Labels (space-separated) |
| `--draft` | false | Create as draft/WIP |
| `--auto-complete` | false | Auto-complete when policies pass |
| `--squash` | false | Squash commits on merge |
| `--delete-source-branch` | false | Delete source branch after merge |
| `--merge-commit-message` | - | Custom merge commit message |
| `--transition-work-items` | false | Transition linked work items (Active → Resolved) |
| `--bypass-policy` | false | Bypass required policies |
| `--bypass-policy-reason` | - | Reason for bypassing policies |
| `--open` | false | Open PR in browser after creation |

**Examples:**

```bash
# Simple PR from current branch
az repos pr create --title "Add new feature" --description "Implements feature X"

# Full PR with reviewers and work items
az repos pr create \
  --title "Feature: User Authentication" \
  --description "Implements OAuth2 login" "Includes unit tests" \
  --source-branch feature/auth \
  --target-branch main \
  --reviewers "user1@example.com" "user2@example.com" \
  --required-reviewers "lead@example.com" \
  --work-items 123 456 \
  --labels "feature" "security" \
  --auto-complete true \
  --delete-source-branch true \
  --squash true

# Draft PR
az repos pr create --title "WIP: New API" --draft true

# PR with auto-complete and work item transition
az repos pr create \
  --title "Fix: Login bug" \
  --auto-complete true \
  --transition-work-items true \
  --work-items 789
```

---

## az repos pr list

List pull requests.

```bash
az repos pr list [--status {active, abandoned, completed, all}]
                 [--creator <USER>]
                 [--reviewer <USER>]
                 [--source-branch <BRANCH>]
                 [--target-branch <BRANCH>]
                 [--repository <REPO>]
                 [--top <NUM>]
                 [--skip <NUM>]
                 [--include-links]
                 [--org <URL>]
                 [--project <NAME>]
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--status` | - | Filter: `active`, `abandoned`, `completed`, `all` |
| `--creator` | - | Filter by creator |
| `--reviewer` | - | Filter by reviewer |
| `--source-branch, -s` | - | Filter by source branch |
| `--target-branch, -t` | - | Filter by target branch |
| `--repository, -r` | - | Repository name or ID |
| `--top` | - | Max number of PRs to return |
| `--skip` | - | Number of PRs to skip (pagination) |
| `--include-links` | false | Include _links in output |

**Examples:**

```bash
# List active PRs
az repos pr list --status active

# List my PRs
az repos pr list --creator "me@example.com"

# List PRs I need to review
az repos pr list --reviewer "me@example.com" --status active

# List PRs targeting main
az repos pr list --target-branch main --status active

# Paginate results
az repos pr list --top 10 --skip 20
```

---

## az repos pr show

Get details of a specific PR.

```bash
az repos pr show --id <PR_ID>
                 [--open]
                 [--org <URL>]
                 [--detect {true, false}]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | PR ID |
| `--open` | No | Open PR in browser |

**Example:**
```bash
az repos pr show --id 123
```

---

## az repos pr update

Update an existing PR.

```bash
az repos pr update --id <PR_ID>
                   [--title <TITLE>]
                   [--description <DESC>]
                   [--status {active, abandoned, completed}]
                   [--draft {true, false}]
                   [--auto-complete {true, false}]
                   [--squash {true, false}]
                   [--delete-source-branch {true, false}]
                   [--merge-commit-message <MSG>]
                   [--transition-work-items {true, false}]
                   [--bypass-policy {true, false}]
                   [--bypass-policy-reason <REASON>]
                   [--org <URL>]
```

| Parameter | Description |
|-----------|-------------|
| `--id` | PR ID (required) |
| `--title` | New title |
| `--description, -d` | New description |
| `--status` | Change status: `active`, `abandoned`, `completed` |
| `--draft` | Convert to/from draft: `true`/`false` |
| `--auto-complete` | Enable/disable auto-complete |
| `--squash` | Enable/disable squash merge |
| `--delete-source-branch` | Delete source branch on completion |
| `--merge-commit-message` | Custom merge message |
| `--transition-work-items` | Transition work items on merge |
| `--bypass-policy` | Bypass policies on completion |
| `--bypass-policy-reason` | Reason for bypass |

**Examples:**

```bash
# Update title and description
az repos pr update --id 123 --title "Updated Title" \
  --description "New description"

# Abandon a PR
az repos pr update --id 123 --status abandoned

# Complete a PR (merge)
az repos pr update --id 123 --status completed

# Convert draft to ready
az repos pr update --id 123 --draft false

# Enable auto-complete
az repos pr update --id 123 --auto-complete true --squash true
```

---

## az repos pr checkout

Checkout PR source branch locally.

```bash
az repos pr checkout --id <PR_ID>
                     [--remote-name <REMOTE>]
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--id` | - | PR ID (required) |
| `--remote-name` | origin | Git remote name |

**Example:**
```bash
az repos pr checkout --id 123
```

---

## az repos pr set-vote

Vote on a pull request.

```bash
az repos pr set-vote --id <PR_ID>
                     --vote {approve, approve-with-suggestions, reject, reset, wait-for-author}
                     [--org <URL>]
                     [--detect {true, false}]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | PR ID |
| `--vote` | Yes | Vote value |

**Vote values:**
- `approve` - Approve the PR
- `approve-with-suggestions` - Approve with suggestions
- `reject` - Reject/request changes
- `wait-for-author` - Wait for author to address feedback
- `reset` - Reset vote (remove previous vote)

**Examples:**
```bash
# Approve a PR
az repos pr set-vote --id 123 --vote approve

# Request changes
az repos pr set-vote --id 123 --vote reject

# Reset your vote
az repos pr set-vote --id 123 --vote reset
```

---

## az repos pr reviewer

Manage PR reviewers.

### Add reviewers

```bash
az repos pr reviewer add --id <PR_ID>
                         --reviewers <USERS>
                         [--org <URL>]
                         [--detect {true, false}]
```

**Example:**
```bash
az repos pr reviewer add --id 123 --reviewers "user1@example.com" "user2@example.com"
```

### List reviewers

```bash
az repos pr reviewer list --id <PR_ID>
                          [--org <URL>]
```

### Remove reviewers

```bash
az repos pr reviewer remove --id <PR_ID>
                            --reviewers <USERS>
                            [--org <URL>]
```

---

## az repos pr work-item

Manage work items linked to a PR.

### Link work items

```bash
az repos pr work-item add --id <PR_ID>
                          --work-items <IDS>
                          [--org <URL>]
```

**Example:**
```bash
az repos pr work-item add --id 123 --work-items 456 789
```

### List linked work items

```bash
az repos pr work-item list --id <PR_ID>
                           [--org <URL>]
```

### Unlink work items

```bash
az repos pr work-item remove --id <PR_ID>
                             --work-items <IDS>
                             [--org <URL>]
```

---

## az repos pr policy

Manage PR policies.

### List policies

```bash
az repos pr policy list --id <PR_ID>
                        [--org <URL>]
                        [--top <NUM>]
                        [--skip <NUM>]
```

### Queue policy evaluation

Re-run policy checks.

```bash
az repos pr policy queue --id <PR_ID>
                         --evaluation-id <EVAL_ID>
                         [--org <URL>]
```

---

## Common Workflows

### Create and auto-complete PR

```bash
az repos pr create \
  --title "Feature: Dashboard" \
  --source-branch feature/dashboard \
  --auto-complete true \
  --delete-source-branch true \
  --squash true \
  --work-items 123
```

### Review workflow

```bash
# List PRs to review
az repos pr list --reviewer "me@example.com" --status active

# Get PR details
az repos pr show --id 456

# Checkout and test locally
az repos pr checkout --id 456

# Approve
az repos pr set-vote --id 456 --vote approve
```

### Complete with bypass (emergency)

```bash
az repos pr update --id 789 \
  --status completed \
  --bypass-policy true \
  --bypass-policy-reason "Critical hotfix for production"
```

## Links

- [az repos pr](https://learn.microsoft.com/en-us/cli/azure/repos/pr?view=azure-cli-latest)
