# az boards iteration

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage iterations (sprints) for projects and teams.

## Commands Overview

| Command | Description |
|---------|-------------|
| `az boards iteration project create` | Create iteration |
| `az boards iteration project delete` | Delete iteration |
| `az boards iteration project list` | List iterations for a project |
| `az boards iteration project show` | Show iteration details |
| `az boards iteration project update` | Update iteration (name, dates, move) |
| `az boards iteration team add` | Add iteration to a team |
| `az boards iteration team list` | List iterations for a team |
| `az boards iteration team list-work-items` | List work-items in an iteration |
| `az boards iteration team remove` | Remove iteration from a team |
| `az boards iteration team set-backlog-iteration` | Set backlog iteration |
| `az boards iteration team set-default-iteration` | Set default iteration |
| `az boards iteration team show-backlog-iteration` | Show backlog iteration |
| `az boards iteration team show-default-iteration` | Show default iteration |

---

## Project Iterations

### az boards iteration project create

Create a new iteration (sprint).

```bash
az boards iteration project create --name <NAME>
                                   [--path <PATH>]
                                   [--start-date <DATE>]
                                   [--finish-date <DATE>]
                                   [--org <URL>]
                                   [--project <NAME>]
                                   [--detect {false, true}]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--name` | Yes | Name of the iteration |
| `--path` | No | Parent path. Creates at root if not specified. Format: `\ProjectName\Iteration\ParentName` |
| `--start-date` | No | Start date. Format: `"2019-06-03"` |
| `--finish-date` | No | End date. Format: `"2019-06-21"` |
| `--org` | No | Organization URL (uses default if configured) |
| `--project, -p` | No | Project name or ID (uses default if configured) |

**Examples:**
```bash
# Create a sprint at root level
az boards iteration project create --name "Sprint 1"

# Create sprint with dates
az boards iteration project create --name "Sprint 2" \
  --start-date "2024-01-15" --finish-date "2024-01-28"

# Create nested iteration
az boards iteration project create --name "Sprint 3" \
  --path "\MyProject\Iteration\Q1 2024"
```

### az boards iteration project list

List all iterations for a project.

```bash
az boards iteration project list [--depth <NUM>]
                                 [--path <PATH>]
                                 [--org <URL>]
                                 [--project <NAME>]
                                 [--detect {false, true}]
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--depth` | 1 | Depth of child nodes to fetch (e.g., `--depth 3`) |
| `--path` | - | Filter to specific path |

**Examples:**
```bash
# List all iterations (depth 1)
az boards iteration project list

# List all iterations with full hierarchy
az boards iteration project list --depth 10

# List iterations under specific path
az boards iteration project list --path "\MyProject\Iteration\2024"
```

### az boards iteration project show

Show details of a specific iteration.

```bash
az boards iteration project show --id <ID>
                                 [--org <URL>]
                                 [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | Iteration ID |

### az boards iteration project update

Update iteration name, dates, or move to new parent.

```bash
az boards iteration project update --path <PATH>
                                   [--name <NEW_NAME>]
                                   [--start-date <DATE>]
                                   [--finish-date <DATE>]
                                   [--child-id <ID>]
                                   [--org <URL>]
                                   [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--path` | Yes | Current path of iteration. Format: `\ProjectName\Iteration\Name` |
| `--name` | No | New name |
| `--start-date` | No | New start date |
| `--finish-date` | No | New end date |
| `--child-id` | No | Move an existing iteration to be child of this one |

**Examples:**
```bash
# Rename iteration
az boards iteration project update --path "\MyProject\Iteration\Sprint 1" \
  --name "Sprint 1 - Completed"

# Update dates
az boards iteration project update --path "\MyProject\Iteration\Sprint 2" \
  --start-date "2024-02-01" --finish-date "2024-02-14"
```

### az boards iteration project delete

Delete an iteration.

```bash
az boards iteration project delete --path <PATH>
                                   [--yes]
                                   [--org <URL>]
                                   [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--path` | Yes | Path of iteration to delete |
| `--yes, -y` | No | Don't prompt for confirmation |

---

## Team Iterations

### az boards iteration team list

List iterations assigned to a team.

```bash
az boards iteration team list --team <TEAM>
                              [--timeframe <FILTER>]
                              [--org <URL>]
                              [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--team` | Yes | Team name or ID |
| `--timeframe` | No | Filter: only `Current` is supported |

**Examples:**
```bash
# List all team iterations
az boards iteration team list --team "Backend Team"

# List current iteration only
az boards iteration team list --team "Backend Team" --timeframe Current
```

### az boards iteration team add

Add an iteration to a team's sprint list.

```bash
az boards iteration team add --id <ITERATION_ID>
                             --team <TEAM>
                             [--org <URL>]
                             [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | Iteration ID to add |
| `--team` | Yes | Team name or ID |

### az boards iteration team remove

Remove an iteration from a team.

```bash
az boards iteration team remove --id <ITERATION_ID>
                                --team <TEAM>
                                [--org <URL>]
                                [--project <NAME>]
```

### az boards iteration team list-work-items

List all work items in a specific iteration for a team.

```bash
az boards iteration team list-work-items --id <ITERATION_ID>
                                         --team <TEAM>
                                         [--org <URL>]
                                         [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--id` | Yes | Iteration ID |
| `--team` | Yes | Team name or ID |

**Example:**
```bash
# Get all work items in Sprint 1 for a team
az boards iteration team list-work-items --id 12345 --team "Backend Team"
```

### az boards iteration team set-backlog-iteration

Set the backlog iteration for a team (where unscheduled items go).

```bash
az boards iteration team set-backlog-iteration --id <ITERATION_ID>
                                               --team <TEAM>
                                               [--org <URL>]
                                               [--project <NAME>]
```

### az boards iteration team set-default-iteration

Set the default iteration for new work items.

```bash
az boards iteration team set-default-iteration --team <TEAM>
                                               [--id <ITERATION_ID>]
                                               [--default-iteration-macro <MACRO>]
                                               [--org <URL>]
                                               [--project <NAME>]
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--team` | Yes | Team name or ID |
| `--id` | No | Specific iteration ID |
| `--default-iteration-macro` | No | Macro like `@CurrentIteration` |

**Example:**
```bash
# Set current iteration as default
az boards iteration team set-default-iteration --team "Backend Team" \
  --default-iteration-macro "@CurrentIteration"
```

### az boards iteration team show-backlog-iteration

Show the backlog iteration for a team.

```bash
az boards iteration team show-backlog-iteration --team <TEAM>
                                                [--org <URL>]
                                                [--project <NAME>]
```

### az boards iteration team show-default-iteration

Show the default iteration for a team.

```bash
az boards iteration team show-default-iteration --team <TEAM>
                                                [--org <URL>]
                                                [--project <NAME>]
```

---

## Common Patterns

### Setup a new sprint

```bash
# 1. Create the iteration
az boards iteration project create --name "Sprint 5" \
  --start-date "2024-03-01" --finish-date "2024-03-14"

# 2. Get the iteration ID from output, then add to team
az boards iteration team add --id <ITERATION_ID> --team "My Team"

# 3. Optionally set as default
az boards iteration team set-default-iteration --team "My Team" --id <ITERATION_ID>
```

### View sprint progress

```bash
# Get all work items in current sprint
az boards iteration team list --team "My Team" --timeframe Current \
  --query "[0].id" -o tsv | xargs -I {} \
  az boards iteration team list-work-items --team "My Team" --id {}
```

## Links

- [az boards iteration](https://learn.microsoft.com/en-us/cli/azure/boards/iteration?view=azure-cli-latest)
- [az boards iteration project](https://learn.microsoft.com/en-us/cli/azure/boards/iteration/project?view=azure-cli-latest)
- [az boards iteration team](https://learn.microsoft.com/en-us/cli/azure/boards/iteration/team?view=azure-cli-latest)
