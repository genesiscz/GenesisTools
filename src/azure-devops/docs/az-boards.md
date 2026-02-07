# az boards

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage Azure Boards.

## Commands

| Command | Description |
|---------|-------------|
| `az boards query` | Query for a list of work items |
| `az boards area` | Manage area paths |
| `az boards area project` | Manage areas for a project |
| `az boards area project create` | Create area |
| `az boards area project delete` | Delete area |
| `az boards area project list` | List areas for a project |
| `az boards area project show` | Show area details for a project |
| `az boards area project update` | Update area |
| `az boards area team` | Manage areas for a team |
| `az boards area team add` | Add area to a team |
| `az boards area team list` | List areas for a team |
| `az boards area team remove` | Remove area from a team |
| `az boards area team update` | Update team area |
| `az boards iteration` | Manage iterations |
| `az boards iteration project` | Manage iterations for a project |
| `az boards iteration project create` | Create iteration |
| `az boards iteration project delete` | Delete iteration |
| `az boards iteration project list` | List iterations for a project |
| `az boards iteration project show` | Show iteration details for a project |
| `az boards iteration project update` | Update project iteration |
| `az boards iteration team` | Manage iterations for a team |
| `az boards iteration team add` | Add iteration to a team |
| `az boards iteration team list` | List iterations for a team |
| `az boards iteration team list-work-items` | List work-items for an iteration |
| `az boards iteration team remove` | Remove iteration from a team |
| `az boards iteration team set-backlog-iteration` | Set backlog iteration for a team |
| `az boards iteration team set-default-iteration` | Set default iteration for a team |
| `az boards iteration team show-backlog-iteration` | Show backlog iteration for a team |
| `az boards iteration team show-default-iteration` | Show default iteration for a team |
| `az boards work-item` | Manage work items |
| `az boards work-item create` | Create a work item |
| `az boards work-item delete` | Delete a work item |
| `az boards work-item show` | Show details for a work item |
| `az boards work-item update` | Update work items |
| `az boards work-item relation` | Manage work item relations |
| `az boards work-item relation add` | Add relation(s) to work item |
| `az boards work-item relation list-type` | List work item relations supported in the organization |
| `az boards work-item relation remove` | Remove relation(s) from work item |
| `az boards work-item relation show` | Get work item, fill relations with friendly name |

## az boards query

Query for a list of work items. Only supports flat queries.

```bash
az boards query [--detect {false, true}]
                [--id]
                [--org --organization]
                [--path]
                [--project]
                [--wiql]
```

### Parameters

| Parameter | Description |
|-----------|-------------|
| `--detect` | Automatically detect organization |
| `--id` | The ID of an existing query. Required unless --path or --wiql are specified |
| `--org, --organization` | Azure DevOps organization URL. Example: `https://dev.azure.com/MyOrganizationName/` |
| `--path` | The path of an existing query. Ignored if --id is specified |
| `--project, -p` | Name or ID of the project |
| `--wiql` | The query in Work Item Query Language format. Ignored if --id or --path is specified |

## Links

- [az boards](https://learn.microsoft.com/en-us/cli/azure/boards?view=azure-cli-latest)
- [az boards area](https://learn.microsoft.com/en-us/cli/azure/boards/area?view=azure-cli-latest)
- [az boards area project](https://learn.microsoft.com/en-us/cli/azure/boards/area/project?view=azure-cli-latest)
- [az boards area team](https://learn.microsoft.com/en-us/cli/azure/boards/area/team?view=azure-cli-latest)
- [az boards iteration](https://learn.microsoft.com/en-us/cli/azure/boards/iteration?view=azure-cli-latest)
- [az boards iteration project](https://learn.microsoft.com/en-us/cli/azure/boards/iteration/project?view=azure-cli-latest)
- [az boards iteration team](https://learn.microsoft.com/en-us/cli/azure/boards/iteration/team?view=azure-cli-latest)
- [az boards work-item](https://learn.microsoft.com/en-us/cli/azure/boards/work-item?view=azure-cli-latest)
- [az boards work-item relation](https://learn.microsoft.com/en-us/cli/azure/boards/work-item/relation?view=azure-cli-latest)
