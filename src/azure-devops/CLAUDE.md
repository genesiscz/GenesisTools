# Azure DevOps — research & API reference

## Context7 Library IDs for Documentation Lookup

When researching Microsoft/Azure APIs, use these context7 library IDs:

| Library ID | Use For | Key Topics |
|------------|---------|------------|
| `/websites/learn_microsoft_en-us_rest_api_azure_devops` | Azure DevOps REST API | Work items, revisions, updates, comments, WIQL, reporting APIs |
| `/microsoftdocs/azure-docs-cli` | Azure CLI commands | `az boards`, `az devops`, `az pipelines`, `az repos`, `az rest` |
| `/microsoftdocs/azure-devops-docs` | Azure DevOps general docs | Process templates, boards config, permissions |

**Usage with context7 MCP:**
```bash
# 1. Resolve library ID
mcp__context7-mcp__resolve-library-id with libraryName="azure devops rest api"

# 2. Query docs (use the resolved ID)
mcp__context7-mcp__get-library-docs with context7CompatibleLibraryID="/websites/learn_microsoft_en-us_rest_api_azure_devops" topic="work item revisions"
```

**When to use context7 vs local docs:**
- **Context7**: For detailed API specs, parameters, response schemas, edge cases
- **Local docs** (`src/azure-devops/docs/`): Quick reference for `az` CLI commands with examples

## Local Azure DevOps CLI Documentation

See `src/azure-devops/docs/` for comprehensive CLI reference (~15K tokens total):
- `az-boards-work-item.md` - Work item CRUD
- `az-boards-iteration.md` - Sprint/iteration management
- `az-repos-pr.md` - Pull request workflows
- `az-rest.md` - Raw REST API calls
- `work-item-history-api-reference.md` - **Revisions, updates, comments APIs** (detailed)

## Azure DevOps API Quick Reference

**Batch endpoints (reduce API calls):**
- `POST /wit/workitemsbatch` - Get up to 200 work items in one call (current state only)
- `GET /wit/reporting/workitemrevisions` - **Batch history** for multiple work items (use for sync)

**Per-item endpoints:**
- `GET /wit/workitems/{id}?$expand=all` - Single work item with all fields/relations
- `GET /wit/workitems/{id}/updates` - Field change deltas (no batch available)
- `GET /wit/workitems/{id}/revisions` - Full snapshots per revision
- `GET /wit/workitems/{id}/comments` - Comments (no cross-item batch)
