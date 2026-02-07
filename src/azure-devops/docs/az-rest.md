# az rest

> Core Azure CLI command for invoking custom REST API requests

Invoke a custom request to any Azure REST API. Automatically authenticates using your logged-in credentials.

## Syntax

```bash
az rest --uri <URL>
        [--method {delete, get, head, options, patch, post, put}]
        [--body <JSON>]
        [--headers <KEY=VALUE>...]
        [--uri-parameters <KEY=VALUE>...]
        [--resource <URL>]
        [--output-file <PATH>]
        [--skip-authorization-header]
```

## Key Features

- **Auto-authentication**: Automatically attaches `Authorization: Bearer <token>` header
- **Smart URL handling**: If URL starts with `/subscriptions/`, prefixes with ARM endpoint
- **Token placeholder**: `{subscriptionId}` is replaced with current subscription
- **Content-Type**: Defaults to `application/json` if body is valid JSON

## Parameters

| Parameter | Description |
|-----------|-------------|
| `--uri, --url, -u` | Request URL (required) |
| `--method, -m` | HTTP method: get, post, put, patch, delete, head, options (default: get) |
| `--body, -b` | Request body (JSON string or @file.json) |
| `--headers` | Space-separated KEY=VALUE pairs or JSON string |
| `--uri-parameters, --url-parameters` | Query parameters as KEY=VALUE or JSON |
| `--resource` | Custom resource URL for AAD token acquisition |
| `--output-file` | Save response to file |
| `--skip-authorization-header` | Don't auto-attach Authorization header |

## Examples

### Azure DevOps REST API

```bash
# List work items by IDs
az rest --method get \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems?ids=1,2,3&api-version=7.0"

# Create a work item
az rest --method post \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/\$Task?api-version=7.0" \
  --headers "Content-Type=application/json-patch+json" \
  --body '[{"op":"add","path":"/fields/System.Title","value":"My Task"}]'

# Update a work item
az rest --method patch \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.0" \
  --headers "Content-Type=application/json-patch+json" \
  --body '[{"op":"add","path":"/fields/System.State","value":"Active"}]'

# Query work items with WIQL
az rest --method post \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.0" \
  --body '{"query":"SELECT [System.Id] FROM workitems WHERE [System.State] = '\''Active'\''"}'
```

### Azure Resource Manager API

```bash
# Get a virtual machine
az rest --method get \
  --uri "/subscriptions/{subscriptionId}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{vm}?api-version=2019-03-01"

# List resources (with query params)
az rest --method get \
  --url "https://management.azure.com/subscriptions/{subscriptionId}/resources?api-version=2019-07-01" \
  --url-parameters \$top=3

# Create resource from file
az rest --method put \
  --url "https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/publicIPAddresses/{name}?api-version=2019-09-01" \
  --body @body.json
```

### Microsoft Graph API

```bash
# Get audit logs
az rest --method get --url "https://graph.microsoft.com/beta/auditLogs/directoryAudits"

# Update user display name
az rest --method patch \
  --url "https://graph.microsoft.com/v1.0/users/user@domain.com" \
  --body '{"displayName": "New Name"}'
```

## Azure DevOps API Reference

For Azure DevOps REST APIs, you typically need:

| API Area | Base URL |
|----------|----------|
| Work Item Tracking | `https://dev.azure.com/{org}/{project}/_apis/wit/...` |
| Git | `https://dev.azure.com/{org}/{project}/_apis/git/...` |
| Build | `https://dev.azure.com/{org}/{project}/_apis/build/...` |
| Release | `https://vsrm.dev.azure.com/{org}/{project}/_apis/release/...` |

Common API versions: `7.0`, `7.1-preview`

## Tips

1. **Use `@file.json`** for complex request bodies
2. **Escape `$` in URLs** (e.g., `\$Task` for work item types)
3. **Use `--output-file`** for large responses
4. **Check `--resource`** if auto-token doesn't work for your API

## Links

- [az rest reference](https://learn.microsoft.com/en-us/cli/azure/reference-index?view=azure-cli-latest#az-rest)
- [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
