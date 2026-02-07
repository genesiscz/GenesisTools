# Azure CLI Documentation

Comprehensive reference for Azure CLI commands for Azure DevOps.

## Quick Setup

```bash
# Install Azure CLI
brew install azure-cli  # macOS
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash  # Linux

# Install Azure DevOps extension
az extension add --name azure-devops

# Login
az login
az devops login  # For PAT-based auth

# Configure defaults (IMPORTANT - saves typing org/project every time)
az devops configure --defaults organization=https://dev.azure.com/MyOrg project=MyProject

# View current configuration
az devops configure --list
```

## Documentation Index

### Azure DevOps Extension

| Doc | Description |
|-----|-------------|
| [az-devops](./az-devops.md) | Organization operations (login, configure, projects, teams, wikis, security) |
| [az-boards](./az-boards.md) | Azure Boards overview (work items, areas, iterations) |
| [az-boards-work-item](./az-boards-work-item.md) | Work item CRUD with full parameter details |
| [az-boards-iteration](./az-boards-iteration.md) | Sprint/iteration management (project & team) |
| [az-pipelines](./az-pipelines.md) | Pipeline management (builds, releases, variables) |
| [az-repos](./az-repos.md) | Repository management (Git repos, refs, policies) |
| [az-repos-pr](./az-repos-pr.md) | Pull request management with full workflows |
| [az-artifacts](./az-artifacts.md) | Package management (Universal Packages) |

### Core Azure CLI

| Doc | Description |
|-----|-------------|
| [az-rest](./az-rest.md) | Raw REST API calls to any Azure/DevOps API |

### REST API Reference (for `az rest`)

| Doc | Description |
|-----|-------------|
| [work-item-history-api-reference](./work-item-history-api-reference.md) | Revisions, updates, comments, reporting APIs |
| [wiql-syntax-reference](./wiql-syntax-reference.md) | WIQL query language (operators, macros, ASOF, links) |

## Common Parameters

Most commands share these parameters:

| Parameter | Description |
|-----------|-------------|
| `--org, --organization` | Azure DevOps organization URL |
| `--project, -p` | Project name or ID |
| `--detect {true, false}` | Auto-detect org/project from git config |
| `--output, -o` | Output format: `json`, `table`, `tsv`, `yaml` |
| `--query` | JMESPath query to filter output |

## Quick Reference

### Work Items

```bash
# Create work item
az boards work-item create --type Task --title "My Task" --assigned-to user@example.com

# Query work items (WIQL)
az boards query --wiql "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'"

# Update work item
az boards work-item update --id 123 --state "In Progress" --discussion "Started work"

# Show work item
az boards work-item show --id 123
```

### Pull Requests

```bash
# Create PR
az repos pr create --title "Feature X" --source-branch feature/x --auto-complete true

# List active PRs
az repos pr list --status active

# Approve PR
az repos pr set-vote --id 123 --vote approve

# Complete PR
az repos pr update --id 123 --status completed
```

### Pipelines

```bash
# List pipelines
az pipelines list

# Run pipeline
az pipelines run --name "Build Pipeline" --branch main

# Show run details
az pipelines runs show --id 456
```

### Iterations (Sprints)

```bash
# Create sprint
az boards iteration project create --name "Sprint 5" \
  --start-date "2024-03-01" --finish-date "2024-03-14"

# List sprints
az boards iteration project list --depth 10

# Add sprint to team
az boards iteration team add --id <ITERATION_ID> --team "My Team"

# List work items in sprint
az boards iteration team list-work-items --id <ITERATION_ID> --team "My Team"
```

### Raw REST API (az rest)

```bash
# Azure DevOps API call
az rest --method get \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems?ids=1,2,3&api-version=7.0"

# Create work item via REST
az rest --method post \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/\$Task?api-version=7.0" \
  --headers "Content-Type=application/json-patch+json" \
  --body '[{"op":"add","path":"/fields/System.Title","value":"My Task"}]'
```

## Output Formatting

```bash
# Table format (human readable)
az boards work-item show --id 123 -o table

# JSON (default)
az boards work-item show --id 123 -o json

# TSV (for scripting)
az boards work-item show --id 123 --query "fields.\"System.Title\"" -o tsv

# Filter with JMESPath
az boards query --wiql "..." --query "[].fields.{ID: 'System.Id', Title: 'System.Title'}"
```

## Links

- [Azure CLI Reference](https://learn.microsoft.com/en-us/cli/azure/reference-index?view=azure-cli-latest)
- [Azure DevOps CLI](https://learn.microsoft.com/en-us/cli/azure/devops?view=azure-cli-latest)
- [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
