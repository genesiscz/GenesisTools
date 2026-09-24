# azure-devops - Azure DevOps Work Item Tool

CLI tool for fetching, tracking, and managing Azure DevOps work items, queries, and dashboards with intelligent caching and change detection.

## Features

-   ✅ **Work Item Management**: Fetch individual work items with full details, comments, and relations
-   ✅ **Query Support**: Run Azure DevOps queries with change detection between runs
-   ✅ **Dashboard Integration**: Extract queries from dashboards automatically
-   ✅ **Smart Caching**: 5-minute cache for work items, 180-day cache for queries (with change detection)
-   ✅ **Change Detection**: Automatically detects new items and updates (state, assignee, severity, title changes)
-   ✅ **Task File Generation**: Saves work items as JSON and Markdown files for easy reference
-   ✅ **Category Organization**: Organize work items into categories (remembered per item)
-   ✅ **Task Folders**: Optional folder structure for better organization
-   ✅ **Batch Operations**: Fetch multiple work items or download all items from a query
-   ✅ **Filtering**: Filter queries by state and severity
-   ✅ **Multiple Output Formats**: AI-optimized, Markdown, or JSON output
-   ✅ **Sprint Backlog**: List the project's iterations and the work items of one sprint, with the effort columns the ADO Backlog tab shows
-   ✅ **Wiki**: List wikis and page trees, read a page with its details and attachments, search, and see what an edit changed

## Sprint / iteration commands

`iterations` lists the project's sprints. `sprint` lists the work items of one of them. Together they replace the manual screenshot of the ADO Backlog tab.

**Neither command needs a team.** `--team` is an optional narrowing filter, never a precondition. See "No team required" below for why.

```bash
# List the project's sprints; the one containing today is marked
tools azure-devops iterations

# Narrow to the iterations one team subscribes to
tools azure-devops iterations --team "Payments Team" -f json

# The current sprint, everything assigned to me, with the Task-only effort sums
tools azure-devops sprint --mine --totals

# Name a sprint by substring or by full iteration path (both resolve to the same one)
tools azure-devops sprint "Sprint 17"
tools azure-devops sprint "Widgets\Sprint 17"

# Backlog stack-rank order, with the Order column, as markdown for a report
tools azure-devops sprint "Sprint 17" --mine --order -f md
```

Worked example, `Sprint 17` with `--mine --totals` and no team configured:

```text
  Sprint 17
  Widgets\Sprint 17  ·  source: project classification nodes (26 iterations)

│ ID    │ TYPE  │ TITLE                     │ STATE       │ ASSIGNED    │ DONE │ LEFT │
│ 10005 │ Task  │ Build the payment form    │ New         │ Jane Doe    │ 0    │ 4    │
│ 10007 │ Task  │ Wire the refund endpoint  │ In Progress │ Jane Doe    │ 85   │ 56   │

  Totals
  Items: 17 (Tasks: 9)
  Task CompletedWork: 139.75 h
  Task RemainingWork: 88 h
```

### No team required

Iterations are **project-level classification nodes**. A team does not own them; it merely subscribes to a subset of them. `System.IterationPath` never contains a team segment, so the work items a sprint contains do not depend on which team you ask through.

The commands therefore read from one of two sources:

| When | Endpoint | Returns |
| ---- | -------- | ------- |
| Team known (`--team` or `config.team`) | `GET {org}/{project}/{team}/_apis/work/teamsettings/iterations` | only that team's subscribed iterations |
| No team at all | `GET {org}/{project}/_apis/wit/classificationnodes/iterations?$depth=3` | every dated iteration in the project |

The project-wide list is a superset, so it can contain iterations the team list does not. Which source was used is always printed, and `-f json` carries it as a `source` field, so the row-count difference is never a silent surprise:

```
source: team "Payments Team" (22 iterations)
source: project classification nodes (26 iterations)
```

The two sources resolve the same sprint to the same `System.IterationPath`, so the work items returned are identical either way.

**Path normalisation.** Classification nodes report a structural path that `System.IterationPath` does not use. It carries a leading backslash and an extra `Iteration` segment:

```
\Widgets\Iteration\Sprint 17     classification node path
Widgets\Sprint 17                System.IterationPath, which is what WIQL needs
```

Strip one leading backslash, then remove the `\Iteration` segment. Nested release folders survive: `\Widgets\Iteration\Release 3\Sprint 17` becomes `Widgets\Release 3\Sprint 17`. Nodes with no start date are structural containers rather than sprints and are dropped.

Worked no-team example:

```bash
$ tools azure-devops iterations
  Iterations
  project classification nodes (26 iterations)
  ...
  Current
  * Sprint 17  (2026-08-20 -> 2026-09-02)

$ tools azure-devops sprint --mine --totals
  # resolves Sprint 17 by date range, queries [System.IterationPath] = 'Widgets\Sprint 17'
```

### Iteration resolution

The `[nameOrPath]` argument resolves in this order:

1. Exact `System.IterationPath` (case-insensitive), e.g. `Widgets\Sprint 17`
2. Exact iteration name (case-insensitive), e.g. `Sprint 17`
3. Case-insensitive substring of the name or the path, e.g. `Sprint 1`

Omit the argument (or pass `current`) to get the iteration whose date range contains today. The finish date is inclusive, so the last day of a sprint still counts as current.

A substring that matches several iterations is refused: the command lists every candidate and exits 1. It never guesses.

### Why not `@CurrentIteration`

`@CurrentIteration` is a WIQL macro resolved by the server from a team context. Two problems make it unusable here:

-   Without a team context Azure DevOps answers `VS402612: The macro '@CurrentIteration' is not supported without a team context` and the request fails with HTTP 500.
-   Even when it resolves, the CLI cannot tell which iteration the server picked, so the output cannot be checked.

These commands therefore resolve the iteration first, from whichever source the "No team required" section describes, and then send an explicit `[System.IterationPath] = '<path>'` predicate. Single quotes in the path are doubled; backslashes are literal in WIQL and need no escaping.

A saved query whose stored WIQL calls `@currentIteration` cannot be run from the CLI either. Such a query returns `VS402612` both project-scoped and team-scoped whenever the team it was authored against no longer exists, and adding a team route segment does not fix it. Use `sprint` instead.

### Sprint options

| Option                 | Description                                                                      | Default |
| ---------------------- | -------------------------------------------------------------------------------- | ------- |
| `--team <name>`        | Optional. Narrows the iteration list to one team's subscriptions. Also accepted before the subcommand. | config  |
| `--mine`               | Only items assigned to me (WIQL `@Me`)                                            | -       |
| `--assigned-to <name>` | Only items assigned to this display name or unique name                           | -       |
| `--totals`             | Print the Task-only CompletedWork / RemainingWork sums                            | -       |
| `--order`              | Sort by Backlog stack rank instead of id, and show the Order column               | -       |
| `-f, --format <fmt>`   | `ai` (box table), `md` (markdown table), `json` (array of row objects)             | `ai`    |

`--totals` sums Tasks only. A User Story and its child Task both sit in the sprint and both carry a Remaining value, so summing every type would count the same work twice. Bug, Incident and Feature rows are excluded from the sum for the same reason; they are still listed.

`--order` sorts by `Microsoft.VSTS.Common.StackRank`, falling back to `Microsoft.VSTS.Common.BacklogPriority`. Only backlog-level types carry a rank, so Tasks usually have none. Unranked rows sort last by ascending id, which is deterministic across runs.

`-f json` emits `{ iteration, source, items }`, where `items` holds one object per row with the keys `id`, `type`, `title`, `state`, `assignedTo`, `completedWork`, `remainingWork`, `order`, `changedDate`. `completedWork` and `remainingWork` are always numbers; a missing field reads as `0`. `order` is `null` when the item is unranked. Adding `--totals` adds a `totals` key. `source` names the iteration list the sprint was resolved from: `{ kind: "team" | "project", team, count, label }`.

`tools azure-devops iterations -f json` emits `{ source, iterations }` with the same `source` shape.

## `history mentions` — where was I named

```bash
# Comments naming you, last 7 days
tools azure-devops history mentions

# Somebody else, explicit window, machine-readable
tools azure-devops history mentions --user "Surname Firstname" --from 2026-09-07 -o json
```

Answers "where was I mentioned in comments", which nothing else here could. `history search` looks
at assignment and state history and has no comment predicate; `history activity --user X` lists what
X *did*, and being named by somebody else is not an action by X.

**It is a two-pass search, and the second pass is not optional.** Pass one asks WIQL for candidates:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.History] CONTAINS '<surname>'
  AND [System.ChangedDate] >= '<from>'
```

The search is scoped to the configured project, like every other query this tool builds. A bare
`--from` / `--to` date means that calendar day in YOUR timezone, both ends inclusive.

`System.History CONTAINS` hits the history INDEX, which also matches a field change made by that
person and older comments still in the item's history. On the run this was built against, pass one
returned 40 work items and only 9 carried a comment in the window that named the user: single-pass
would have been 77% false positives. Pass two therefore fetches each candidate's comments, strips
the HTML and keeps the comments written inside the window whose text names the person.

Both numbers are reported, never just the survivors, so you can see how much the index over-matched:
`11 mention(s) in 9 work item(s) · 40 index candidate(s), 31 of them index-only`. The JSON form
carries the same thing as `candidates: { count, ids }` beside `mentions`.

**Pass two costs one HTTP request per candidate**, so the command refuses rather than starting a run
it cannot finish: past 500 candidates it stops and names the count, and `--max-candidates <n>` raises
the ceiling. Truncating the list instead would drop real mentions and still print a confident total,
which is the failure this search exists to end. The search term is a single word off the display
name, so a common given name over a wide window is exactly how the ceiling gets hit; narrow the
window with `--from` / `--to` first.

`--user` is resolved through the team roster first, so `Novakova Tereza` typed without diacritics
becomes the roster's own spelling before anything searches for it. A name the roster does not
recognise, or any name when the roster cannot be reached, is used exactly as typed, and the command
says so: the history index holds names as written, so a different spelling finds nothing and a
silent zero would read as "nobody ever named you".

`@me`, the default, asks the Azure CLI for the signed-in account and then goes through the same
roster. It does NOT degrade to that account name when the roster is unreachable, because an address
is not a name: `userMatches` compares display names and `[System.History] CONTAINS` holds them as
written, so searching for an address answers zero either way. It stops and tells you to pass
`--user "<Surname Firstname>"` instead.

Two details that are easy to get wrong:

- The WIQL term is the RAW surname of the RESOLVED name, diacritics included, because the index
  holds the name as written. Stripping accents there loses every hit.
- Comment text is normalized as TEXT, not as a display name. Running a name normalizer over prose
  deletes bracketed spans, and a mention written inside a parenthesis then disappears with them.

## Ancestor walk and `tree`

```bash
# Climb the parent chain to the root
tools azure-devops ancestors <id>

# Cap the climb when you only want the near neighbourhood
tools azure-devops ancestors <id> --depth 2

# Parents, children and related items of one work item
tools azure-devops tree <id>
tools azure-devops tree <id> --format json
```

**The walk is unbounded by default, and that is a correctness property rather than a tuning knob.**
It used to stop after three ancestors. Clarity routes a work item to a Clarity task by taking the
first ancestor whose id appears in a Clarity task name, and that id match is the only evidence-based
routing Clarity has; every other rule is operator judgement. An ancestor one level past a numeric
ceiling is therefore not "a slightly shorter answer", it is reported as **no recommendation at all**,
and the work gets routed by guesswork instead.

The chain that exposed it was five levels deep: task, user story, feature, umbrella feature, epic.
The epic was the level naming the Clarity task, four ancestors above the work item, so the old
depth-3 default dropped exactly the level that mattered. Chains grow a level whenever someone
inserts an umbrella Feature, so a cap silently loses another work item every time the hierarchy
deepens. `--depth <n>` still caps the climb for anyone who wants one; nothing caps it by default.

Both walk functions (`walkAncestors`, `walkAncestorsBatched` in `lib/ancestors.ts`) keep a set of
the ids they already asked for, so an unbounded walk ends on a cyclic parent chain instead of
looping. `walkAncestorsBatched` costs one request per tree LEVEL rather than one per ancestor, so
climbing to the root is close to free.

`tree <id>` returns the whole neighbourhood of one work item as an `AdoTaskSimple`:

```jsonc
{
  "adoID": 0, "title": "", "assignedTo": null, "type": "",
  "parent": [],   // the chain to the root, nearest ancestor first
  "children": [], // every hierarchy child
  "related": [],  // every non-hierarchy link
  "createdAt": null, "updatedAt": null
}
```

Every entry inside `parent`, `children` and `related` is itself an `AdoTaskSimple` carrying its own
`adoID`, `title`, `assignedTo` and `type`, with empty link arrays, so the shape is one level deep
and cannot loop. Link data is cached per work item alongside the fields cache, so a repeated `tree`
of the same id within the five-minute freshness window makes no HTTP call. Adding a child changes
the answer and nothing else invalidates it, so the window is deliberately short rather than the
seven-day section TTL. `--force` refetches, exactly as it does for `workitem`.

## Wiki

```bash
# The project's wikis, and the page tree under a path (ids looked up for up to 50 pages)
tools azure-devops wiki list
tools azure-devops wiki pages "/Projects" --depth 2
tools azure-devops wiki pages "/Projects" --depth all --ids

# One page: details table (id, path, URL, git path, last change, views, subpages, attachments) + markdown
tools azure-devops wiki get "https://dev.azure.com/MyOrg/MyProject/_wiki/wikis/MyProject.wiki/1234/Some-Page"
tools azure-devops wiki get 1234 --no-content
tools azure-devops wiki get "/Projects/Some Page" --images -o page.md
tools azure-devops wiki get 1234 -f json

# Full-text search over the wiki pages
tools azure-devops wiki search "payment gateway" --top 10

# Who changed the page, and what the last edit (or any two versions) changed
tools azure-devops wiki history 1234
tools azure-devops wiki diff 1234
tools azure-devops wiki diff 1234 08bab813 fd625f6e
```

A page is named by a wiki URL (`/_wiki/wikis/<wiki>/<id>/<slug>` or `?pagePath=…&pageId=…`), a page
id, or a page path. `--wiki <name|id>` picks the wiki; without it the command uses the wiki named in
the URL, else the project wiki. The name also matches without `.wiki` and with spaces for dashes.

- **Ids in `pages`:** the Pages API returns an id only for the page that was asked for, never for its
  subpages. `pages` looks every id up (one call per page) when the listing has 50 pages or fewer,
  and on `--ids` beyond that. A page path always works as input where an id is missing.
- **`--images`** downloads every `/.attachments/…` file the page uses from the wiki's git repository
  into `.claude/azure/wiki/<wiki>/<pageId>/` (or `--output-dir`), and points the links in the printed
  markdown at the copies.
- **`history` and `diff`** read the git history of the page file, so they see every edit, including
  ones nobody announced. `diff` takes full or abbreviated commit ids; without them it shows the last
  edit. Versions from before a page rename are not reachable, because the history follows the
  current file path.
- **`search`** runs on the separate `almsearch.dev.azure.com` host and returns page paths that
  `wiki get` accepts directly.

## CLI Usage

### Basic Examples

```bash
# Configure for your project (first-time setup)
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"

# Fetch a work item
tools azure-devops --workitem 12345

# Fetch multiple work items
tools azure-devops --workitem 12345,12346,12347

# Fetch a query with change detection
tools azure-devops --query d6e14134-9d22-4cbb-b897-b1514f888667

# Filter query results by state
tools azure-devops --query <id> --state Active,Development

# Filter by severity
tools azure-devops --query <id> --severity A,B

# Download all work items from a query
tools azure-devops --query <id> --download-workitems

# Organize into categories
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes

# Use task folders (each task in its own subfolder)
tools azure-devops --workitem 12345 --task-folders

# Get dashboard queries
tools azure-devops --dashboard <url|id>

# List all cached work items
tools azure-devops --list

# Force refresh (bypass cache)
tools azure-devops --workitem 12345 --force

# Filter changes by date range
tools azure-devops --query <id> --changes-from 2026-01-24
tools azure-devops --query <id> --changes-from 2026-01-20 --changes-to 2026-01-25

# Create work items (interactive mode)
tools azure-devops --create -i

# Create from template file
tools azure-devops --create --from-file template.json

# Generate template from query (analyzes patterns)
tools azure-devops --create "https://dev.azure.com/.../query/abc" --type Bug

# Generate template from existing work item
tools azure-devops --create "https://dev.azure.com/.../_workitems/edit/12345"

# Quick non-interactive creation
tools azure-devops --create --type Task --title "Fix login bug"
tools azure-devops --create --type Bug --title "Error in checkout" --severity "A - critical"
```

### Commands

| Command        | Description                                    |
| -------------- | ---------------------------------------------- |
| `--configure`  | Configure Azure DevOps connection for project  |
| `--query`      | Fetch query results with change detection      |
| `--workitem`   | Fetch work item(s) with full details           |
| `--dashboard`  | Extract queries from a dashboard               |
| `--list`       | List all cached work items                     |
| `--create`     | Create new work items (interactive or from template) |
| `iterations`   | List the project's sprints (alias `sprints`)      |
| `sprint`       | List the work items of one sprint              |
| `history mentions` | Comments that named a user, in a date window |
| `history search` | Work items by assignee and state; `--wiql --current` is server-side, `--all-projects` widens it to every project, `--exclude-state Closed` drops closed items |
| `ancestors`    | Walk a work item's parent chain up to the root  |
| `tree`         | Parents, children and related items of one work item |
| `wiki`         | Wikis: `list`, `pages`, `get`, `search`, `history`, `diff` |

### Options

| Option                        | Description                                           | Default |
| ----------------------------- | ----------------------------------------------------- | ------- |
| `--format <ai\|md\|json>`     | Output format                                         | `ai`    |
| `--force`, `--refresh`, `--no-cache` | Force refresh, ignore cache                    | -       |
| `--state <states>`            | Filter by state (comma-separated)                     | -       |
| `--severity <sev>`            | Filter by severity (comma-separated)                  | -       |
| `--changes-from <date>`       | Show changes from this date (ISO format)              | -       |
| `--changes-to <date>`         | Show changes up to this date (ISO format)             | -       |
| `--download-workitems`        | With `--query`: download all work items to tasks/     | -       |
| `--category <name>`           | Save to tasks/<category>/ (remembered per work item)  | -       |
| `--task-folders`              | Save in tasks/<id>/ subfolder (only for new files)    | -       |
| `--help`                      | Show help message                                     | -       |

### Create Options

| Option                  | Description                                           | Default |
| ----------------------- | ----------------------------------------------------- | ------- |
| `-i`, `--interactive`   | Interactive mode with step-by-step prompts            | -       |
| `--from-file <path>`    | Create from template JSON file                        | -       |
| `--type <type>`         | Work item type (Bug, Task, User Story, etc.)          | -       |
| `--title <text>`        | Work item title (for quick non-interactive creation)  | -       |
| `--tags <tags>`         | Tags (comma-separated)                                | -       |
| `--assignee <email>`    | Assignee email                                        | -       |
| `--parent <id>`         | Parent work item ID                                   | -       |

## First-Time Setup

### Prerequisites

1. **Install Azure CLI**: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

2. **Install Azure DevOps extension**:
   ```bash
   az extension add --name azure-devops
   ```

3. **Login with device code** (recommended for corporate environments):
   ```bash
   az login --allow-no-subscriptions --use-device-code
   ```
   This will:
   - Display a code and URL
   - Open the URL in your browser

   If that fails (e.g. `AADSTS530036` — Conditional Access blocks the device-code flow),
   use the interactive browser flow with the Azure DevOps scope:

   ```bash
   az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default --allow-no-subscriptions
   ```

   - Enter the code to authenticate

### Configure for Your Project

Run with any Azure DevOps URL from your project:

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."
```

This auto-detects:
- Organization URL
- Project name
- Project ID (fetched via API)

Configuration is saved to `.claude/azure/config.json` in your project directory.

## Storage Structure

### Global Cache

```
~/.genesis-tools/azure-devops/
└── cache/
    ├── query-{id}.json           # Query cache (180 days TTL)
    ├── workitem-{id}.json        # Work item cache (5 min TTL)
    └── dashboard-{id}.json       # Dashboard cache
```

### Project Storage

```
{your-project}/
└── .claude/azure/
    ├── config.json               # Project configuration
    └── tasks/
        ├── {id}-{Slug-Title}.json      # Flat structure (default)
        ├── {id}-{Slug-Title}.md
        ├── {id}/                        # Task folder structure (--task-folders)
        │   ├── {id}-{Slug-Title}.json
        │   └── {id}-{Slug-Title}.md
        └── {category}/                  # Category subdirectory (--category)
            ├── {id}-{Slug-Title}.json
            └── {id}/                    # Task folder in category
                └── {id}-{Slug-Title}.json
```

**Config Search**: The tool searches for `.claude/azure/config.json` starting from the current directory, then up to 3 parent levels. This allows running the tool from subdirectories.

## Output Formats

### AI Format (Default)

Optimized for AI consumption with:
- Summary tables
- Change detection highlights
- Actionable next steps
- Relative timestamps

Example:
```
# Query Results: d6e14134-9d22-4cbb-b897-b1514f888667

Last checked: 5 minutes ago

Total: 12 work items

| ID | Title | State | Severity | Assignee |
|-----|-------|-------|----------|----------|
| 12345 | Fix login bug | Active | A | John Doe |
...

## Changes Detected (2)

### NEW: #12346 - Add dark mode
- State: New
- Severity: B
- Assignee: unassigned

### UPDATED: #12345 - Fix login bug
- State: Active → Development
- Assignee: unassigned → John Doe
```

### Markdown Format

Clean markdown tables suitable for documentation:

```markdown
| ID | Title | State | Severity | Assignee |
|---|---|---|---|---|
| 12345 | Fix login bug | Active | A | John Doe |
```

### JSON Format

Raw JSON data for programmatic use:

```json
{
  "items": [...],
  "changes": [...]
}
```

## Features Explained

### Work Item Caching (5-minute TTL)

Work items are cached for 5 minutes to reduce API calls. When using cached data, the output shows:

```
📦 From cache (2 minutes ago) - use --force to refresh
```

Use `--force` or `--refresh` to bypass cache and fetch fresh data.

### Query Change Detection

When you run a query multiple times, the tool automatically detects:

- **New Items**: Work items added to the query since last run
- **Updated Items**: Changes to:
  - State (e.g., Active → Development)
  - Assignee
  - Severity
  - Title
  - Comments (detected via revision number)

Changes are highlighted in the AI format output with before/after values.

### Relations

Work items display related items when available:
- **Parent**: Parent work item (if part of hierarchy)
- **Children**: Child work items
- **Related**: Related work items

Relations are parsed from the work item API response - no extra API calls needed.

### Task Files

Work items are automatically saved to `.claude/azure/tasks/` with slugified filenames:
- `{id}-{title-slug}.json` - Full JSON data with all fields
- `{id}-{title-slug}.md` - Human-readable markdown with formatted description and comments

Files are created/updated whenever you fetch a work item.

### Batch Download

Use `--download-workitems` with `--query` to download all work items from a query:

```bash
tools azure-devops --query <id> --download-workitems
```

This:
1. Fetches the query results
2. For each work item, fetches full details (comments, relations)
3. Saves each item as JSON and Markdown files

### Categories

Organize work items into subdirectories using `--category`:

```bash
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes
```

**Category Memory**: The category is **remembered per work item** in the global cache. Future fetches of the same work item will automatically use the same category, even without specifying `--category` again.

### Task Folders

Use `--task-folders` to save each work item in its own subfolder:

```bash
tools azure-devops --workitem 12345 --task-folders
# Creates: tasks/12345/12345-Task-Title.json

tools azure-devops --query <id> --download-workitems --category react19 --task-folders
# Creates: tasks/react19/12345/12345-Task-Title.json
```

**Important**: Task folders only apply to **new files**. If a work item already exists somewhere (flat or in folder), it stays in its current location. This prevents accidental reorganization of existing files.

### Work Item Creation

The `--create` command supports multiple modes for creating new work items:

#### Interactive Mode

Step-by-step guided creation with project selection, field prompts, and back navigation (ESC to go back):

```bash
tools azure-devops --create -i
```

Features:
- Project selection (cached for 30 days)
- Work item type selection with common types shown first
- Required field validation based on work item type
- Tags, assignee, and parent linking support
- Summary review before creation

#### Template-Based Creation

Generate a template from existing data, fill it in, then create:

```bash
# Generate template from a query (analyzes patterns in similar items)
tools azure-devops --create "https://dev.azure.com/.../query/abc" --type Bug

# Generate template from an existing work item (pre-fills fields)
tools azure-devops --create "https://dev.azure.com/.../_workitems/edit/12345"

# Fill the template, then create
tools azure-devops --create --from-file ".claude/azure/tasks/created/template.json"
```

Template files use the schema `azure-devops-workitem-v1` and include field hints with allowed values.

#### Quick Non-Interactive Creation

Create a work item directly from command line:

```bash
tools azure-devops --create --type Task --title "Fix login bug"
tools azure-devops --create --type Bug --title "Error in checkout" --severity "A - critical" --tags "frontend,urgent"
```

### Change Filtering

Filter query changes by date range to focus on recent activity:

```bash
# Show changes from a specific date
tools azure-devops --query <id> --changes-from 2026-01-24

# Show changes within a date range
tools azure-devops --query <id> --changes-from 2026-01-20 --changes-to 2026-01-25
```

Dates should be in ISO format (YYYY-MM-DD).

## Workflow Examples

### Daily Standup Preparation

```bash
# Fetch your active work items query
tools azure-devops --query <your-active-items-query-id>

# Review changes since yesterday
# Tool automatically highlights new/updated items

# Get full details for items that changed
tools azure-devops --workitem 12345,12346 --force
```

### Sprint Planning

```bash
# Download all items from sprint backlog query
tools azure-devops --query <sprint-query-id> --download-workitems --category sprint-2024-01

# Filter by severity for prioritization
tools azure-devops --query <sprint-query-id> --severity A,B --download-workitems --category sprint-2024-01
```

### Bug Triage

```bash
# Get dashboard with all bug queries
tools azure-devops --dashboard <bugs-dashboard-id>

# Download active bugs
tools azure-devops --query <active-bugs-query-id> --state Active --download-workitems --category bugs

# Organize critical bugs separately
tools azure-devops --query <critical-bugs-query-id> --severity A --download-workitems --category critical-bugs --task-folders
```

### Feature Development

```bash
# Download feature work items
tools azure-devops --query <feature-query-id> --download-workitems --category react19 --task-folders

# Files are organized as:
# tasks/react19/12345/12345-Feature-Title.json
# tasks/react19/12345/12345-Feature-Title.md

# Later, fetch updates (category remembered automatically)
tools azure-devops --workitem 12345 --force
```

## Configuration Reference

The config file (`.claude/azure/config.json`) contains:

```json
{
  "org": "https://dev.azure.com/MyOrg",
  "project": "MyProject",
  "projectId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "apiResource": "499b84ac-1321-427f-aa17-267ca6975798"
}
```

- **org**: Organization URL (extracted from your Azure DevOps URL)
- **project**: Project name (URL-decoded)
- **projectId**: Project GUID (fetched via API during configure)
- **apiResource**: Azure DevOps OAuth resource ID (constant, same for all orgs)

## Troubleshooting

### "No Azure DevOps configuration found"

Run the configure command with any Azure DevOps URL from your project:

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
```

### "Azure CLI Authentication Required"

Ensure you're logged in:

```bash
az login --allow-no-subscriptions --use-device-code
```

If that fails with `AADSTS530036` (Conditional Access policy blocks device code), use:

```bash
az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default --allow-no-subscriptions
```

### SSL Issues (Proxy/Corporate Environments)

If SSL errors occur:
1. Close Proxyman/proxy tools
2. Or use: `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1 az ...`

### "Failed to get project info"

- Verify your Azure CLI is authenticated: `az account show`
- Check that the project name matches exactly (case-sensitive)
- Ensure you have access to the project

### Cache Issues

- Use `--force` to bypass cache
- Clear cache manually: Delete `~/.genesis-tools/azure-devops/cache/`
- Work item cache expires after 5 minutes automatically
- Query cache expires after 180 days

### Task Files Not Found

The tool searches for task files in:
1. Root tasks directory: `.claude/azure/tasks/`
2. Category subdirectories: `.claude/azure/tasks/{category}/`
3. Task folders: `.claude/azure/tasks/{id}/` or `.claude/azure/tasks/{category}/{id}/`

If a file was moved manually, the tool will create a new one in the expected location based on current settings.

## Architecture

### Caching Strategy

- **Query Cache**: 180-day TTL, stores query results for change detection
- **Work Item Cache**: 5-minute TTL, stores work item metadata (not full data)
- **Dashboard Cache**: 180-day TTL, stores dashboard query list

### Change Detection Algorithm

1. Load previous cache (if exists)
2. Fetch current data from API
3. Compare items by ID:
   - New items: Present in current but not in cache
   - Updated items: Changed date or revision number increased
4. Detect field changes: state, assignee, severity, title
5. Generate change summary

### File Organization Logic

1. **Check Existing**: Search for file in all possible locations
2. **Respect Existing**: If file exists, keep it where it is
3. **Apply Settings**: For new files, use:
   - Category from args → cache → none
   - Task folder from args → cache → false
4. **Cleanup**: Remove old files if path changed (different slug/category/folder)

## Dependencies

- **Azure CLI**: Required for authentication and API access
- **Azure DevOps Extension**: `az extension add --name azure-devops`
- **Bun**: Runtime environment
- **Storage Utility**: Uses `src/utils/storage.ts` for global cache management

## Claude AI Skill

This tool includes a Claude AI skill that enables AI assistants to automatically use the Azure DevOps tool when users ask about work items, queries, or tasks.

### Installing the Skill

Install the skill for Claude AI (Codex/Cursor):

```bash
# Using skill-installer (if available)
tools skill-installer install azure-devops

# Or manually copy the skill file
cp skills/azure-devops.skill ~/.codex/skills/
```

The skill automatically triggers when users mention:
- "get workitem", "fetch task", "show query"
- "download tasks", "analyze workitem", "analyze task"
- Azure DevOps URLs

### Skill Features

- **Automatic Tool Invocation**: AI assistants automatically use `tools azure-devops` when relevant
- **Work Item Analysis**: Can spawn codebase exploration agents to analyze work items
- **Query Handling**: Automatically fetches and processes query results
- **Task Organization**: Handles category and folder organization automatically

## TimeLog Commands

The TimeLog feature integrates with the third-party TimeLog extension for Azure DevOps.

### Prerequisites

1. TimeLog extension must be installed in your Azure DevOps organization
2. Run auto-configuration to fetch TimeLog settings:

```bash
tools azure-devops timelog configure
```

This automatically fetches the API key from Azure DevOps Extension Data API and saves it to `.claude/azure/config.json`.

Then add your user info to the config:

```json
{
  "timelog": {
    "functionsKey": "<auto-fetched>",
    "defaultUser": {
      "userId": "<your-azure-ad-object-id>",
      "userName": "<Your Display Name>",
      "userEmail": "<your-email@example.com>"
    }
  }
}
```

### Commands

```bash
# Auto-configure TimeLog API key
tools azure-devops timelog configure

# List available time types
tools azure-devops timelog types
tools azure-devops timelog types --format json

# List time logs for a work item
tools azure-devops timelog list -w 12345
tools azure-devops timelog list -w 12345 --format md

# Add time log entry (quick)
tools azure-devops timelog add -w 12345 -h 2 -t "Development"
tools azure-devops timelog add -w 12345 -h 1 -m 30 -t "Code Review" -c "PR review"
tools azure-devops timelog add -w 12345 -h 0 -m 30 -t "Test"

# Add time log entry (interactive)
tools azure-devops timelog add -i
tools azure-devops timelog add -w 12345 -i

# Bulk import from JSON file
tools azure-devops timelog import entries.json
tools azure-devops timelog import entries.json --dry-run
```

### Import File Format

```json
{
  "entries": [
    {
      "workItemId": 12345,
      "hours": 2,
      "timeType": "Development",
      "date": "2026-02-04",
      "comment": "Implemented feature X"
    },
    {
      "workItemId": 12346,
      "hours": 1,
      "minutes": 30,
      "timeType": "Code Review",
      "date": "2026-02-04",
      "comment": "PR #123 review"
    }
  ]
}
```

### Hours vs Minutes

The TimeLog API uses minutes internally:
- `--hours 2` → 120 minutes
- `--hours 1 --minutes 30` → 90 minutes
- `--minutes 30` → ERROR (ambiguous)
- `--hours 0 --minutes 30` → 30 minutes (explicit)

## Related Tools

- `mcp-manager`: Manage MCP server configurations
- `mcp-tsc`: TypeScript diagnostics MCP server
- `mcp-ripgrep`: Code search MCP server
- `git-last-commits-diff`: View git changes for work items

## Documentation

- [Azure DevOps CLI Reference](https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops)
- [Azure CLI Installation](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
