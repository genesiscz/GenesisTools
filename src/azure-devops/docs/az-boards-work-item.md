# az boards work-item

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage work items.

## Commands

| Command | Description |
|---------|-------------|
| `az boards work-item create` | Create a work item |
| `az boards work-item delete` | Delete a work item |
| `az boards work-item show` | Show details for a work item |
| `az boards work-item update` | Update work items |
| `az boards work-item relation` | Manage work item relations |
| `az boards work-item relation add` | Add relation(s) to work item |
| `az boards work-item relation list-type` | List work item relations supported in the organization |
| `az boards work-item relation remove` | Remove relation(s) from work item |
| `az boards work-item relation show` | Get work item, fill relations with friendly name |

## az boards work-item create

```bash
az boards work-item create --title
                           --type
                           [--area]
                           [--assigned-to]
                           [--description]
                           [--detect {false, true}]
                           [--discussion]
                           [--fields]
                           [--iteration]
                           [--open]
                           [--org --organization]
                           [--project]
                           [--reason]
```

| Parameter | Description |
|-----------|-------------|
| `--title` | Title of the work item |
| `--type` | Name of the work item type (e.g. Bug, Task, User Story) |
| `--area` | Area the work item is assigned to (e.g. Demos) |
| `--assigned-to` | Name of the person the work item is assigned-to |
| `--description, -d` | Description of the work item |
| `--discussion` | Comment to add to a discussion in a work item |
| `--fields, -f` | Space separated "field=value" pairs for custom fields |
| `--iteration` | Iteration path of the work item (e.g. Demos\Iteration 1) |
| `--open` | Open the work item in the default web browser |
| `--reason` | Reason for the state of the work item |

### Examples

```bash
# Create a bug
az boards work-item create --type Bug --title "Fix login issue" --assigned-to user@example.com

# Create a task with custom fields
az boards work-item create --type Task --title "Implement feature" \
  --area "MyProject\Backend" --iteration "MyProject\Sprint 1" \
  --fields "Microsoft.VSTS.Scheduling.RemainingWork=8"
```

## az boards work-item show

```bash
az boards work-item show --id
                         [--as-of]
                         [--detect {false, true}]
                         [--expand {all, fields, links, none, relations}]
                         [--fields]
                         [--open]
                         [--org --organization]
```

| Parameter | Description |
|-----------|-------------|
| `--id` | The ID of the work item |
| `--as-of` | Work item details as of a particular date and time |
| `--expand` | The expand parameters for work item attributes (default: all) |
| `--fields, -f` | Comma-separated list of requested fields |
| `--open` | Open the work item in the default web browser |

### Examples

```bash
# Show work item details
az boards work-item show --id 123

# Show specific fields only
az boards work-item show --id 123 --fields "System.Title,System.State,System.AssignedTo"

# Show work item as it was on a specific date
az boards work-item show --id 123 --as-of "2024-01-15"
```

## az boards work-item update

```bash
az boards work-item update --id
                           [--area]
                           [--assigned-to]
                           [--description]
                           [--detect {false, true}]
                           [--discussion]
                           [--fields]
                           [--iteration]
                           [--open]
                           [--org --organization]
                           [--reason]
                           [--state]
                           [--title]
```

| Parameter | Description |
|-----------|-------------|
| `--id` | The id of the work item to update |
| `--state` | State of the work item (e.g. active, closed) |
| `--title` | Title of the work item |
| `--assigned-to` | Name of the person the work item is assigned-to |
| `--area` | Area the work item is assigned to |
| `--iteration` | Iteration path of the work item |
| `--description, -d` | Description of the work item |
| `--discussion` | Comment to add to a discussion |
| `--reason` | Reason for the state of the work item |

### Examples

```bash
# Update state
az boards work-item update --id 123 --state "In Progress"

# Update multiple fields
az boards work-item update --id 123 --state "Active" --assigned-to "user@example.com" \
  --iteration "MyProject\Sprint 2"

# Add a comment
az boards work-item update --id 123 --discussion "Started working on this"
```

## az boards work-item delete

```bash
az boards work-item delete --id
                           [--destroy]
                           [--detect {false, true}]
                           [--org --organization]
                           [--project]
                           [--yes]
```

| Parameter | Description |
|-----------|-------------|
| `--id` | Unique id of the work item |
| `--destroy` | Permanently delete this work item (default: false, moves to recycle bin) |
| `--yes, -y` | Do not prompt for confirmation |

## Links

- [az boards work-item](https://learn.microsoft.com/en-us/cli/azure/boards/work-item?view=azure-cli-latest)
- [az boards work-item relation](https://learn.microsoft.com/en-us/cli/azure/boards/work-item/relation?view=azure-cli-latest)
