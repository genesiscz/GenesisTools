# tools azure-devops

A command line for Azure DevOps Boards: work items, saved queries, dashboards, sprints, history, comments, wikis,
Test Plans, generated project manifests and TimeLog time entries. It reads through the Azure CLI login you already
have, caches what it fetched, saves each work item as JSON and Markdown under `.claude/azure/tasks/`, and tells you
what changed in a query since the last run. People use it to read and update work without the web UI; agents use it
because every command has a plain text and a JSON form.

## Quick start

Once per machine, then once per project:

```bash
# Install the Azure DevOps extension of the Azure CLI
az extension add --name azure-devops

# Sign in with a device code, the recommended default (Troubleshooting has the fallback)
az login --allow-no-subscriptions --use-device-code

# Point the tool at your project with any Azure DevOps URL of it (writes .claude/azure/config.json)
tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
```

Then:

```bash
# One work item, with its description, comments and relations
tools azure-devops workitem 12345

# A saved query by id, URL or name, with what changed since the last run
tools azure-devops query "Open bugs"

# The current sprint: my items and the Task effort sums
tools azure-devops sprint --mine --totals

# Post a markdown comment kept in a file
tools azure-devops comment add 12345 --file note.md

# Log two hours on a task (needs `timelog configure` once)
tools azure-devops timelog add -w 12345 -h 2 -t "Development"
```

`tools azure-devops --help` lists the commands, `--help-full` (or `-?`) prints an overview of the commands with
examples, and `--readme` prints this page. Each command's own `--help` lists all of its options.

## Commands

| Group | Commands |
| ----- | -------- |
| Setup | `configure` |
| Work items | `workitem`, `list`, `workitem-create`, `workitem-update`, `comment`, `ancestors`, `tree` |
| Queries | `query`, `dashboard` |
| Sprints | `iterations`, `sprint` |
| History | `history show`, `history search`, `history sync`, `history activity`, `history mentions` |
| Wiki | `wiki list`, `wiki pages`, `wiki get`, `wiki search`, `wiki history`, `wiki diff` |
| Test plans | `testplan list`, `show`, `search`, `create`, `update`, `delete`, `points`, `outcome` |
| | `testplan suite …`, `testplan case …` |
| Manifests | `maintenance fields`, `workflow`, `sprints`, `areas`, `queries`, `identities`, `tags`, `sync`, `check` |
| Time | `timelog add`, `list`, `types`, `delete`, `import`, `configure`, `export-month`, `prepare-import …` |

Aliases: `configure` is `config`, `workitem` is `wi`, `workitem-create` is `create`, `workitem-update` is `update`,
`list` is `ls`, `iterations` is `sprints`, `history show` is `history get`, `wiki list` is `wiki ls`, `wiki get` is
`wiki show`, `comment list` is `comment ls`, `comment delete` is `comment rm`, `testplan list` is `testplan ls`, and
`maintenance fields` is `maintenance get-fields`.

### Global options

These go before or after the subcommand.

| Option | What it does |
| ------ | ------------ |
| `--config <path>` | Use this `config.json` (env: `AZURE_DEVOPS_CONFIG`). Default: search from the working directory |
| `--team <name>` | Optional team; narrows team-scoped lists (overrides `config.team`) |
| `-v, --verbose` | Debug logging |
| `-?, --help-full` | An overview of the commands, with examples |
| `--readme` | Print this README and exit |
| `-V, --version` | Print the version |

### `configure <url>`: connect a project

```bash
tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
tools azure-devops configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."

# A board or backlog URL also stores the team
tools azure-devops configure \
  "https://dev.azure.com/MyOrg/MyProject/_backlogs/backlog/Payments%20Team/Stories"
```

`configure` takes any Azure DevOps URL of the project. It:

1. Stops when `az` is not on PATH, or when `az account show` fails (it prints the login commands).
2. Warns when the `azure-devops` extension is missing.
3. Reads the organization URL and the project name (URL-decoded) from the URL, and fetches the project id and the
   organization id through the API.
4. Stores the team when the URL is a board or backlog URL.
5. Writes `.claude/azure/config.json` in the working directory (or at `--config` / `AZURE_DEVOPS_CONFIG`).
6. Runs `az devops configure --defaults organization=… project=…`, so plain `az boards` commands use the same
   project. A failure here is a warning; it prints the command to run by hand.

Running `configure` again for the **same** organization and project keeps `team` and the `timelog` block that the URL
cannot carry. The `timelog.functionsKey` exists nowhere else, so overwriting it would lose it. A **different** project
starts a fresh config, because a team and a TimeLog key belong to one project. A config file that exists but does not
parse is refused and left untouched; comments and trailing commas are accepted, since people edit the file by hand.

### Work items

#### `workitem <input>` (alias `wi`)

```bash
tools azure-devops workitem 12345
tools azure-devops workitem 12345,12346,12347                # several at once
tools azure-devops wi 12345 --full                           # whole description and every comment
tools azure-devops workitem 12345 --force                    # skip the cache
tools azure-devops workitem 12345,12346 -f json              # always one JSON array
tools azure-devops workitem 12345 --category hotfixes        # save under tasks/hotfixes/
tools azure-devops workitem 12345 --task-folders --images    # own folder, with the inline screenshots
tools azure-devops workitem 12345 --attachments-suffix .har  # download the .har attachments
```

The input is an id, a comma-separated list of ids, or a work item URL.

| Option | What it does |
| ------ | ------------ |
| `-f, --format <ai\|md\|json>` | Output format (default `ai`) |
| `--force` | Fetch again, ignore the cache |
| `--full` | No truncation of the description and the comments |
| `--category <name>` | Save to `tasks/<category>/` (remembered per work item) |
| `--task-folders` | Save in a `tasks/<id>/` folder (new files only) |
| `--images` | Download inline images from the description and comments |
| `--attachments-from <datetime>` | Download attachments created after this time |
| `--attachments-to <datetime>` | Download attachments created before this time |
| `--attachments-prefix <prefix>` | Only attachments whose name starts with this |
| `--attachments-suffix <suffix>` | Only attachments whose name ends with this (for example `.har`) |
| `--output-dir <path>` | Folder for downloaded attachments |

- **Truncation.** The `ai` format shows the first 500 characters of the description, the last 5 comments, and the
  first 300 characters of each comment. When it cut anything, it prints the same command with `--full` added.
- **`-f json`** is always a single JSON array: `[{…}]` for one id, `[{…},{…}]` for many. Only `ai` and `md` separate
  items with `---`.
- **Relations** (parent, children, related items) come from the work item response. They cost no extra request.
- **Attachments** are downloaded when any `--attachments-*` option or `--output-dir` is given. Without one, the output
  lists them and suggests `--attachments-suffix .har`. `--output-dir <dir>` alone downloads every attachment. A date
  filter (`--attachments-from`, `--attachments-to`) skips an attachment that has no created date.

Where downloads go:

| What | Default | With `--task-folders` | With `--output-dir <dir>` |
| ---- | ------- | --------------------- | ------------------------- |
| Attachment | `tasks/<id>-<name>` | `tasks/<id>/<id>-<name>` | `<dir>/<id>-<name>` |
| Inline image | `tasks/<id>-<image>.png` | `tasks/<id>/<id>-<image>.png` | |

The `.md` file links the images by relative path. `--task-folders --images` together keep each work item's files in
one folder.

#### Task files, categories and task folders

Every fetch writes the work item to `.claude/azure/tasks/` as two files with a slugified title:

- `<id>-<Slug-Title>.json`: the full data with every field.
- `<id>-<Slug-Title>.md`: readable markdown with the description and the comments.

`--category <name>` puts the files in `tasks/<name>/`. The category is **remembered per work item** in the global
cache, so a later fetch of the same id goes to the same folder without `--category`.

`--task-folders` puts each item in its own folder (`tasks/12345/12345-Title.json`, or
`tasks/react19/12345/12345-Title.json` with a category). It applies to **new files only**: an item that already
exists somewhere stays where it is, so a flag never reorganizes existing files.

How the location is chosen:

1. Look for the item's file in every possible place: `tasks/`, `tasks/<category>/`, `tasks/<id>/` and
   `tasks/<category>/<id>/`.
2. When a file exists, keep it where it is.
3. For a new file, take the category from the flag, then the cache, then none; take the task folder from the flag,
   then the cache, then off.
4. When the path changed (a new title slug, category or folder), remove the old files.

A file you moved by hand is not found; the tool writes a new one where the current settings put it.

#### `list` (alias `ls`)

Lists the cached work items, newest fetch first: id, title, state, cache age, and whether a task file, history and
comments are cached.

#### `workitem-create [source]` (alias `create`)

```bash
tools azure-devops workitem-create -i                                        # guided prompts
tools azure-devops workitem-create --type Task --title "Fix login bug"       # quick
tools azure-devops workitem-create --type Bug --title "Error in checkout" \
  --severity "A - critical" --tags "frontend,urgent"
tools azure-devops workitem-create --type Task --title "Update docs" --parent 12345
tools azure-devops workitem-create "https://dev.azure.com/.../_queries/query/abc" --type Bug   # template from a query
tools azure-devops workitem-create "https://dev.azure.com/.../_workitems/edit/12345"           # template from an item
tools azure-devops workitem-create --from-file template.json                 # create from a template
```

| Option | What it does |
| ------ | ------------ |
| `-i, --interactive` | Step-by-step prompts |
| `--from-file <path>` | Create from a template JSON file |
| `--type <type>` | Work item type (Bug, Task, User Story, …) |
| `--title <text>` | Title (required for quick mode) |
| `--severity <sev>` | Severity |
| `--tags <tags>` | Tags, comma-separated |
| `--assignee <email>` | Assignee |
| `--parent <id>` | Parent work item id |

Four modes:

- **Interactive** (`-i`): pick the project (the list is cached 30 days) and the type (common types first), fill the
  fields the type requires, add tags, assignee and a parent, then review a summary before it creates anything. ESC
  goes back one step.
- **Template from a query**: the source is a query URL or a bare query id (GUID). It analyzes the query's items (area
  paths, tags, severities in use) and writes a template with hints and allowed values. `--type` defaults to Bug.
- **Template from a work item**: writes a template pre-filled from that item, parent link included.
- **From a template file** (`--from-file`): creates the item. This is the mode for scripts and agents.

Generated templates go to `.claude/azure/tasks/created/<timestamp>-New<Type>.json`. They use the schema
`azure-devops-workitem-v1`:

```json
{
  "$schema": "azure-devops-workitem-v1",
  "type": "Bug",
  "fields": {
    "title": "Error in checkout flow",
    "description": "<p>Description here</p>",
    "severity": "A - critical",
    "tags": ["frontend", "checkout"],
    "assignedTo": "alice@example.com",
    "areaPath": "Project\\Area",
    "iterationPath": "Project\\Sprint1"
  },
  "relations": { "parent": 12345 }
}
```

#### `workitem-update <workitem>` (alias `update`)

Reads one work item, including `multilineFieldsFormat` (which multiline fields are HTML and which are Markdown), and
updates fields in a single JSON Patch. **Without `--confirm` it prints the patch and sends nothing.** Field names are
yours; the command hard-codes none.

```bash
# Read the item and its field formats
tools azure-devops workitem-update 12345 --json

# Plan, then send, a description change with local images
tools azure-devops workitem-update 12345 \
  --field System.Description=@description.html \
  --markdown System.Description \
  --image-root ./drafts \
  --reuse uploaded-images.json \
  --rev 6 \
  --confirm \
  --json
```

| Option | What it does |
| ------ | ------------ |
| `--field <name=value>` | Set a field; repeat per field. A value starting with `@` is a file path |
| `--markdown <field>` | Switch a multiline field to Markdown when it is not already; repeat per field |
| `--rev <n>` | Refuse unless the item is still at this rev |
| `--image-root <dir>` | Folder that relative `<img src>` paths resolve against (default: working directory) |
| `--reuse <file>` | Already uploaded images: `{ "<file name>": { "sha256": "<hex>", "url": "<attachment url>" } }` |
| `--confirm` | Send the patch |
| `--json` | Print the live item, the dry-run plan, or the verify result as JSON |

- **Markdown cannot be switched back.** The server refuses the reverse change.
- The patch always starts with `test /rev`: the live rev, or `--rev` when it still matches.
- A local `<img src>` is uploaded as an attachment and the link points at it. When `--reuse` names the file and its
  sha256 still matches, the stored URL is used and nothing is uploaded again.
- After `--confirm` the command reads the item back and compares each field it sent. A plain field (a title, a tag
  list) must match exactly. In an HTML or Markdown field it accepts the rewrites the server applies to rich text:
  - a character stored as a numeric reference (an emoji as `&#128279;`, decimal or hex);
  - a quoted integer attribute stored without quotes (`width="375"` becomes `width=375`; `width="48%"` keeps them);
  - a declaration inside a tag that gains a closing semicolon;
  - an image `src` replaced by its attachment URL.

  It also ignores HTML comments. An HTML field ignores space that HTML does not show; a Markdown field keeps its line
  breaks and indentation, because they carry meaning. Any other difference exits 1 and prints the field with the first
  line that differs.

#### `comment`: work item comments

```bash
tools azure-devops comment list 12345                      # newest first; --format json for the raw objects
tools azure-devops comment add 12345 --file note.md        # markdown by default
tools azure-devops comment add 12345 --text "Short note"   # inline text; --file - reads stdin
tools azure-devops comment edit 12345 678 --file note.md   # replace the text of comment 678
tools azure-devops comment delete 12345 678 --yes          # --yes is required without a terminal
```

| Subcommand | Options |
| ---------- | ------- |
| `list <workitem>` | `--format table\|json` (default `table`) |
| `add <workitem>` | `--file <path>` (`-` reads stdin), `--text <text>`, `--html` |
| `edit <workitem> <commentId>` | `--file <path>`, `--text <text>`, `--html` |
| `delete <workitem> <commentId>` | `-y, --yes`: delete without asking (required when no terminal can ask) |

Comments go as **markdown** (Comments API `7.1-preview.4`, `format=markdown`), so bold, lists, code spans and
`[text](url)` links render in the web UI. `--html` sends HTML instead. The command adds no mention by itself; existing
markdown comments carry mentions as `@<identity-guid>`. The work item can be an id or a URL.

Keep a draft in a file, post it with `add --file`, and apply corrections with `edit --file`. The thread then keeps one
comment instead of a trail of reposts.

#### `ancestors <id>` and `tree <id>`

```bash
tools azure-devops ancestors 12345              # the parent chain up to the root
tools azure-devops ancestors 12345 --depth 2    # only the two nearest ancestors
tools azure-devops tree 12345                   # parents, children and related items
tools azure-devops tree 12345 --format json
tools azure-devops tree 12345 --force           # refetch instead of reading the cache
```

| Command | Options |
| ------- | ------- |
| `ancestors <id>` | `--depth <n>` (default: climb to the root), `--format table\|json` (default `table`) |
| `tree <id>` | `--force`, `--format table\|json` (default `table`) |

Both take `table|json`, not `ai|md|json`.

**The ancestor walk is unbounded by default. That is a correctness property, not a tuning knob.** It used to stop
after three ancestors. `tools clarity` routes a work item to a Clarity task by the first ancestor whose id appears in a
Clarity task name. That id match is the only evidence-based routing Clarity has; every other rule is operator
judgement. An ancestor one level past a cap is therefore not "a slightly shorter answer": it becomes **no
recommendation at all**, and the work is routed by guesswork. The chain that exposed it was five levels deep (task,
user story, feature, umbrella feature, epic). The epic named the Clarity task, four ancestors above the work item, so
the old depth-3 default dropped exactly the level that mattered. Chains grow a level whenever someone inserts an
umbrella Feature, so a cap loses another work item each time the hierarchy deepens. `--depth <n>` still caps the climb
when you want one.

Both walk functions (`walkAncestors` and `walkAncestorsBatched` in `lib/ancestors.ts`) keep a set of the ids they
already asked for, so an unbounded walk ends on a cyclic parent chain instead of looping. `walkAncestorsBatched` costs
one request per tree level, not one per ancestor, so climbing to the root is close to free.

`tree <id>` returns the neighbourhood of one work item as an `AdoTaskSimple`:

```jsonc
{
  "adoID": 0, "title": "", "assignedTo": null, "type": "",
  "parent": [],   // the chain to the root, nearest ancestor first
  "children": [], // every hierarchy child
  "related": [],  // every non-hierarchy link
  "createdAt": null, "updatedAt": null
}
```

Each entry in `parent`, `children` and `related` is itself an `AdoTaskSimple` with its own `adoID`, `title`,
`assignedTo` and `type` and empty link arrays, so the shape is one level deep and cannot loop. Links are cached per
work item beside the fields, so a repeated `tree` of the same id within five minutes makes no HTTP call. Adding a child
changes the answer and nothing else invalidates it, so this window is deliberately short, not the seven-day section
TTL. `--force` refetches, as it does for `workitem`.

### Queries and dashboards

#### `query <input>`

```bash
tools azure-devops query d6e14134-9d22-4cbb-b897-b1514f888667   # by id
tools azure-devops query "https://dev.azure.com/MyOrg/MyProject/_queries/query/<id>"
tools azure-devops query "Open bugs"                               # by name, fuzzy
tools azure-devops query <id> --state Active,Development
tools azure-devops query <id> --severity A,B
tools azure-devops query <id> --changes-from 2026-01-20 --changes-to 2026-01-25
tools azure-devops query <id> --download-workitems --category react19 --task-folders
tools azure-devops query <id> --tree                               # the saved tree with its own columns
tools azure-devops query <id> --tree -f json
```

| Option | What it does |
| ------ | ------------ |
| `-f, --format <ai\|md\|json>` | Output format (default `ai`) |
| `--force` | Fetch again, ignore the cache |
| `--state <states>` | Only these states (comma-separated) |
| `--severity <sev>` | Only these severities (comma-separated) |
| `--changes-from <date>` | Only changes from this date (`YYYY-MM-DD`) |
| `--changes-to <date>` | Only changes up to this date |
| `--download-workitems` | Fetch every item in full and save it to `tasks/` |
| `--category <name>` | With `--download-workitems`: save to `tasks/<category>/` |
| `--task-folders` | With `--download-workitems`: save in `tasks/<id>/` |
| `--images` | Download inline images from descriptions and comments |
| `--tree` | Print the saved query as a tree, with every column the query shows |

**The input** is a query id (GUID), a query URL, or a saved query name. A name is matched against the saved queries;
a match of 95% or better is used directly, otherwise the best match is used and the alternatives are printed. Queries
you used recently rank higher. The saved query list is cached 30 days and **`--force` does not refresh it**: for a
query created or renamed since, pass its id or URL, or delete `queries-list.json` in the cache folder. A WIQL
statement is refused, because fuzzy matching would return an unrelated query's rows; use `history search --wiql`
instead.

**Change detection.** Each run is compared with the previous run of the same query:

- **New items**: present now, not last time.
- **Updated items**: the changed date or the revision went up. The output shows before and after for state, assignee,
  severity and title. A new comment raises the revision, so it shows as an update too.
- **`-f json`** prints `{ "items": [...], "changes": [...] }`. `changes` is `[]` on the first run of a query, when
  there is no earlier run to compare with.

**`--download-workitems`** fetches each item in full (comments, relations) and saves its JSON and Markdown files. A
query run reuses a cached work item whenever its revision is unchanged.

**`--tree`.** A release query is often a tree. Without `--tree` the result is a flat list and the query's own columns
are dropped. `--tree` keeps the parent and child indent and every column; text is one line per work item. JSON is one
object with `name`, `path`, `queryType`, `wiql`, `asOf`, `columns` and `roots`. Each node has `id`, `url`, `values`
(column name to string or null) and `children`. A missing value is `null`, never omitted. `--state`, `--severity` and
`--changes-*` are not applied in this mode. A flat query is a single level of roots.

#### `dashboard <input>`

```bash
tools azure-devops dashboard <url|id>
```

Lists the queries a dashboard shows, so you can run each with `query`. `-f ai|md|json` (default `ai`).

### Sprints

`iterations` lists the project's sprints. `sprint` lists the work items of one of them, with the effort columns the
ADO Backlog tab shows. Together they replace a screenshot of the Backlog tab.

```bash
tools azure-devops iterations                                # every sprint; the one containing today is marked
tools azure-devops iterations --team "Payments Team" -f json # one team's subscribed sprints
tools azure-devops sprint --mine --totals                    # current sprint, my items, Task effort sums
tools azure-devops sprint "Sprint 17"                        # by name or substring
tools azure-devops sprint "Widgets\Sprint 17"                # by full iteration path (same sprint)
tools azure-devops sprint "Sprint 17" --mine --order -f md   # Backlog stack-rank order, as markdown
```

| Option | What it does | Default |
| ------ | ------------ | ------- |
| `-f, --format <ai\|md\|json>` | `ai` (box table), `md` (markdown table), `json` | `ai` |
| `--team <name>` | Optional. Narrows the sprint list to one team's subscriptions | config |
| `--mine` | `sprint`: only items assigned to me (WIQL `@Me`) | |
| `--assigned-to <name>` | `sprint`: only items assigned to this display name or unique name | |
| `--totals` | `sprint`: print the Task-only CompletedWork and RemainingWork sums | |
| `--order` | `sprint`: sort by Backlog stack rank and show the Order column | |

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

Reading the rows: **Task** rows carry spendable effort. **User Story** and **Feature** rows are context only. **Bug**
and **Incident** rows need their children checked first. The `md` and `json` forms add `ChangedDate`.

**Do not scan the local task files instead.** `.claude/azure/tasks/` holds every work item ever fetched, and its
`RemainingWork` is never zeroed, so filtering it gives sprints full of items closed months earlier.

#### No team required

Iterations are **project-level classification nodes**. A team does not own them; it subscribes to a subset of them.
`System.IterationPath` never contains a team segment, so the work items in a sprint do not depend on which team you
ask through. `--team` is an optional filter, never a precondition. The commands read one of two sources:

- **Team known** (`--team` or `config.team`): `GET {org}/{project}/{team}/_apis/work/teamsettings/iterations`
  returns that team's iterations.
- **No team**: `GET {org}/{project}/_apis/wit/classificationnodes/iterations?$depth=3` returns every dated
  iteration.

The project-wide list is a superset, so it can hold iterations the team list does not. The source is always printed,
and `-f json` carries it as `source`, so a different row count is never a silent surprise:

```text
source: team "Payments Team" (22 iterations)
source: project classification nodes (26 iterations)
```

Both sources resolve the same sprint to the same `System.IterationPath`, so the work items are identical either way.

**Path normalisation.** Classification nodes report a structural path that `System.IterationPath` does not use: a
leading backslash and an extra `Iteration` segment.

```text
\Widgets\Iteration\Sprint 17     classification node path
Widgets\Sprint 17                System.IterationPath, which is what WIQL needs
```

The tool strips one leading backslash, then removes the `\Iteration` segment. Nested release folders survive:
`\Widgets\Iteration\Release 3\Sprint 17` becomes `Widgets\Release 3\Sprint 17`. Nodes without a start date are
structural containers, not sprints, and are dropped.

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

#### Iteration resolution

The `[nameOrPath]` argument resolves in this order:

1. Exact `System.IterationPath`, case-insensitive (`Widgets\Sprint 17`).
2. Exact iteration name, case-insensitive (`Sprint 17`).
3. Case-insensitive substring of the name or the path (`Sprint 1`).

Leave it out (or pass `current`) for the iteration whose dates contain today. The finish date is inclusive, so the
last day of a sprint still counts as current. A substring that matches several iterations is refused: the command
lists every candidate and exits 1. It never guesses.

#### Why not `@CurrentIteration`

`@CurrentIteration` is a WIQL macro that the server resolves from a team context. Two problems make it unusable here:

- Without a team context Azure DevOps answers `VS402612: The macro '@CurrentIteration' is not supported without a
  team context`, and the request fails with HTTP 500.
- Even when it resolves, the CLI cannot tell which iteration the server picked, so the output cannot be checked.

So the commands resolve the iteration first, from the sources above, and then send an explicit
`[System.IterationPath] = '<path>'` predicate. Single quotes in the path are doubled; backslashes are literal in WIQL.

A saved query whose stored WIQL calls `@currentIteration` cannot run from the CLI either. Such a query returns
`VS402612` both project-scoped and team-scoped whenever the team it was written against no longer exists, and adding
a team segment to the route does not fix it. Do not retry it; use `sprint`.

#### Totals, order and JSON

`--totals` sums **Tasks only**. A User Story and its child Task both sit in the sprint and both carry a Remaining
value, so summing every type would count the same work twice. Bug, Incident and Feature rows are left out of the sum
for the same reason; they are still listed.

`--order` sorts by `Microsoft.VSTS.Common.StackRank`, then `Microsoft.VSTS.Common.BacklogPriority`. Only
backlog-level types carry a rank, so Tasks usually have none. Unranked rows sort last by ascending id, which is the
same on every run.

`sprint -f json` prints `{ iteration, source, items }`. Each item has `id`, `type`, `title`, `state`, `assignedTo`,
`completedWork`, `remainingWork`, `order` and `changedDate`. `completedWork` and `remainingWork` are always numbers (a
missing field reads as `0`); `order` is `null` when the item has no rank. `--totals` adds a `totals` key. `source` is
`{ kind: "team" | "project", team, count, label }`. `iterations -f json` prints `{ source, iterations }` with the same
`source` shape.

### History

Who changed what and when, how long an item spent in each state, what a person did, and where a person was named.

| Subcommand | What it does |
| ---------- | ------------ |
| `history show <id>` (alias `get`) | One item's history: assignment and state periods, time in state |
| `history search` | Items by assignee and state, server-side (`--wiql`) or from the local cache |
| `history sync` | Fetch the history of every cached work item into the cache |
| `history activity` | One user's actions across work items, grouped by day |
| `history mentions` | Comments that named a user inside a date window |

Dates take `--from` / `--to` with `--since` / `--until` as aliases, in ISO form.

#### `history show <id>`

```bash
tools azure-devops history show 12345                     # summary
tools azure-devops history show 12345 -f timeline         # every change in order
tools azure-devops history show 12345 --state Active      # how long it was Active
tools azure-devops history show 12345 --assigned-to Jane  # the time Jane held it
```

Options: `-f summary|timeline|json` (default `summary`), `--force`, `--assigned-to <name>` (fuzzy), `--state
<states>`, `--from` / `--since`, `--to` / `--until`.

**A date is the moment the change was made**: `System.ChangedDate` of that update, then `System.AuthorizedDate`, and
only then a real `revisedDate`. The API's `revisedDate` is the moment the next revision replaced this one
(`9999-01-01` on the latest), so it is only a last resort. An update with none of the three prints `no date`, never
the current time. Before 2026-09-17 every state and assignment change showed one revision late: a bug closed on
5 August printed 1 September, the day an automation edited a field. Who closed an item is
`Microsoft.VSTS.Common.ClosedBy` of the closing revision, never the item's last `changedBy`.

#### `history search`

```bash
tools azure-devops history search --assigned-to-me --wiql                  # ever assigned to me (@Me)
tools azure-devops history search --assigned-to "Jane" --wiql              # ever assigned to Jane
tools azure-devops history search --assigned-to "Jane" --wiql --current    # assigned to Jane now
tools azure-devops history search --assigned-to "Jane" --min-time 2h       # local cache, held at least 2 h
tools azure-devops history search --state Active --since 2026-01-01 --wiql
tools azure-devops history search --assigned-to "Smith" --wiql --current \
  --exclude-state Closed --all-projects                                    # open items in every project
```

| Option | What it does |
| ------ | ------------ |
| `--assigned-to <name>` | Fuzzy team match; diacritics are normalized ("Jane" finds "Jane Doe (Contractor)") |
| `--assigned-to-me` | Same as `--assigned-to @me`; uses WIQL `@Me` and turns on `--wiql` |
| `--state <states>` | Items ever in these states |
| `--from`, `--since`, `--to`, `--until` | Date window |
| `--min-time <duration>` | Minimum time in the state or assignment (`2h`, `30m`) |
| `--wiql` | Server-side WIQL `EVER` query; needs no local history |
| `--current` | Current assignment (`=` instead of `EVER`) |
| `--exclude-state <states>` | `[System.State] NOT IN (...)`; turns on `--wiql` |
| `--all-projects` | Every project of the organization; turns on `--wiql` |
| `-o, --output <table\|json>` | Output format (default `table`) |

- Without `--wiql`, the search reads the local history cache, so run `history sync` first. It prints the date range
  of the cached data and the last sync time.
- **A name outside the team**: when no team member matches, `--current` falls back to
  `[System.AssignedTo] CONTAINS '<name>'`, which finds deactivated accounts and people in no team. Without `--current`
  the name is used as the exact display name, because ADO rejects `EVER … CONTAINS` on identity fields.
- `--exclude-state Closed` is the way to ask for "everything not Closed".
- `--all-projects` drops `[System.TeamProject] = @project`. A person's items in another project are invisible without
  it. The table gains a Project column, and each URL points at the item's own project.

#### `history sync`

```bash
tools azure-devops history sync                     # per item, for every cached work item
tools azure-devops history sync --since 2026-02-01  # only revisions since a date
tools azure-devops history sync --batch             # the batch reporting API
tools azure-devops history sync --dry-run           # what would be synced
tools azure-devops history sync -f                  # force: sync everything again
```

The default mode makes one targeted request per work item, which is faster below about 200 items. `--batch` uses the
reporting API (`wit/reporting/workitemrevisions`), which is better from about 500 items.

#### `history activity`: what a user did

```bash
tools azure-devops history activity --from 2026-09-07 --to 2026-09-11                   # my week, from the cache
tools azure-devops history activity --user "Smith Jane" --from 2026-09-07 --discover -o json
```

Lists one user's actions across work items, grouped by day: state changes, assignments, comments, creations and field
edits. By default it reads the history cache, so run `history sync` first. `--discover` asks Azure DevOps for every
item the user changed, including items that were never cached. `--no-comments` skips the comment fetch and is faster.
`-o, --format` takes `timeline` (default), `summary` or `json`. `--user` defaults to `@me`.

#### `history mentions`: where was I named

```bash
tools azure-devops history mentions                                              # me, last 7 days
tools azure-devops history mentions --user "Doe Jane" --from 2026-09-07 -o json  # someone else
```

This answers "where was I mentioned in comments", which nothing else here can. `history search` looks at assignment
and state history and has no comment predicate. `history activity --user X` lists what X did, and being named by
somebody else is not an action by X.

Options: `--user <name>` (default `@me`), `--from` (default: 7 days ago) / `--since`, `--to` / `--until`,
`--max-candidates <n>` (default 500), `-o table|json` (default `table`).

**It is a two-pass search, and the second pass is not optional.** Pass one asks WIQL for candidates:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.History] CONTAINS '<surname>'
  AND [System.ChangedDate] >= '<from>'
```

The search is scoped to the configured project, like every query this tool builds. A bare `--from` / `--to` date
means that calendar day in your time zone, both ends inclusive.

`System.History CONTAINS` hits the history **index**, which also matches a field change made by that person and older
comments still in the item's history. On the run this was built against, pass one returned 40 work items and only 9
had a comment in the window that named the user: a single pass would have been 77% false positives. Pass two
therefore fetches each candidate's comments, strips the HTML, and keeps the comments written inside the window whose
text names the person.

Both numbers are printed, never only the survivors, so you can see how much the index over-matched:
`11 mention(s) in 9 work item(s) · 40 index candidate(s), 31 of them index-only`. The JSON form carries the same as
`candidates: { count, ids }` beside `mentions`.

**Pass two costs one HTTP request per candidate**, so the command refuses a run it cannot finish: past 500 candidates
it stops, names the count and exits 1, and `--max-candidates <n>` raises the ceiling. Cutting the list instead would
drop real mentions and still print a confident total, which is the failure this search exists to end. The search term
is one word of the display name, so a common given name over a wide window is how the ceiling gets hit; narrow
`--from` / `--to` first.

`--user` is resolved through the team roster first, so `Muller Anna` typed without diacritics becomes the roster's
own spelling (`Müller Anna`) before anything searches for it. A name the roster does not know, or any name when the
roster cannot be reached, is used as typed, and the command says so: the history index holds names as written, so a
different spelling finds nothing, and a silent zero would read as "nobody ever named you".

`@me` asks the Azure CLI for the signed-in account and then goes through the same roster. It does **not** fall back
to the account name when the roster is unreachable, because an address is not a name: name matching compares display
names and `[System.History] CONTAINS` holds them as written, so searching for an address finds zero either way. It
stops and tells you to pass `--user "<Surname Firstname>"`.

Two details that are easy to get wrong:

- The WIQL term is the **raw** surname of the **resolved** name, diacritics included, because the index holds the
  name as written. Stripping accents there loses every hit.
- Comment text is normalized as text, not as a display name. A name normalizer run over prose deletes bracketed
  spans, and a mention written inside parentheses would disappear with them.

### Wiki

```bash
tools azure-devops wiki list                                   # the project's wikis
tools azure-devops wiki pages "/Projects" --depth 2            # the page tree under a path
tools azure-devops wiki pages "/Projects" --depth all --ids    # every level, every page id
tools azure-devops wiki get "https://dev.azure.com/MyOrg/MyProject/_wiki/wikis/MyProject.wiki/1234/Some-Page"
tools azure-devops wiki get 1234 --no-content                  # details only
tools azure-devops wiki get "/Projects/Some Page" --images -o page.md
tools azure-devops wiki get 1234 -f json
tools azure-devops wiki search "payment gateway" --top 10
tools azure-devops wiki history 1234                           # who changed the page
tools azure-devops wiki diff 1234                              # what the last edit changed
tools azure-devops wiki diff 1234 08bab813 fd625f6e            # between two versions
```

| Subcommand | Options |
| ---------- | ------- |
| `list` | `--format table\|json` |
| `pages [path]` | `--wiki <name>`, `--depth <n\|all>` (default 1), `--ids`, `--format table\|json` |
| `get <page>` | `--wiki`, `-f md\|json`, `--no-content`, `--images`, `--output-dir <path>` |
| | `-o, --output <file>`, `--views <days>` (default 30; 0 skips the call) |
| `search <text...>` | `--wiki`, `--top <n>` (default 25), `--skip <n>`, `--format table\|json` |
| `history <page>` | `--wiki`, `--top <n>` (default 20), `--format table\|json` |
| `diff <page> [from] [to]` | `--wiki`, `--context <n>` (default 3), `--format diff\|json` |

`wiki get` prints a details table (id, path, URL, git path, last change, views, subpages, attachments) and then the
page markdown.

A page is named by a wiki URL (`/_wiki/wikis/<wiki>/<id>/<slug>` or `?pagePath=…&pageId=…`), a page id, or a page
path. `--wiki <name|id>` picks the wiki; without it the command uses the wiki in the URL, else the project wiki. The
name also matches without `.wiki` and with spaces for dashes.

- **Ids in `pages`.** The Pages API returns an id only for the page that was asked for, never for its subpages.
  `pages` looks every id up (one call per page) when the listing has 50 pages or fewer, and with `--ids` beyond that.
  A page path always works as input where an id is missing.
- **`--images`** downloads every `/.attachments/…` file the page uses from the wiki's git repository into
  `.claude/azure/wiki/<wiki>/<pageId>/` (or `--output-dir`), and points the links in the printed markdown at the
  copies.
- **`history` and `diff`** read the git history of the page file, so they see every edit, also ones nobody announced.
  `diff` takes full or abbreviated commit ids; without them it shows the last edit. Versions from before a page rename
  are not reachable, because the history follows the current file path.
- **`search`** runs on the separate `almsearch.dev.azure.com` host and returns page paths that `wiki get` accepts.
- Before you trust an analysis page you read earlier, check its **Last change** row or run `wiki history`: an edit
  after your read may have changed the requirement.

### Test plans (`testplan`)

Read and change the Test Plans hub. Commands on an existing plan or suite take a plan id or a pasted Test Plans URL
(`_testPlans/define?planId=…&suiteId=…`); suite commands take `<plan> <suite>` or one URL with both ids. `list`,
`search`, `case show` and `create` need no plan. Reads print markdown; every command takes `-f md|json`. `--save` on
`show`, `suite show` and `case show` writes a snapshot under `.claude/azure/testplans/`.

```bash
tools azure-devops testplan list --active --owner alice         # plans: id, name, state, owner, iteration, dates
tools azure-devops testplan show <plan|url>                     # plan details and the suite tree with test case counts
tools azure-devops testplan search "checkout" --kind suite,case # plans, suites, test cases by name or id
tools azure-devops testplan suite show <plan> <suite>           # type, parent, child suites, test cases with points
tools azure-devops testplan points <plan> <suite>               # the Execute tab: outcome, tester, configuration
tools azure-devops testplan case show <id|url>                  # fields, numbered steps with expected results, shared steps, parameters, suites
```

**Writes print the request they would send and send nothing until `--confirm`:**

```bash
tools azure-devops testplan create --name "Release 5" --start 2026-11-10 --end 2026-11-20 --confirm
tools azure-devops testplan update <plan> --state Inactive --confirm
tools azure-devops testplan suite create <plan> --name "Cart" --parent <suite> --confirm            # static by default
tools azure-devops testplan suite update <plan> <suite> --name "Basket" --parent <suite> --confirm  # rename, move
tools azure-devops testplan suite add <plan> <suite> --cases 101,102 --confirm                     # existing test cases
tools azure-devops testplan suite remove <plan> <suite> --cases 101 --confirm                      # the work items stay
tools azure-devops testplan case create --title "Pay by card" --steps steps.md --plan <plan> --suite <suite> --confirm
tools azure-devops testplan case update <id> --steps steps.md --rev 4 --confirm
tools azure-devops testplan outcome <plan> <suite> --cases 101 --outcome passed --confirm          # or --points
```

| Command | Main options |
| ------- | ------------ |
| `list` | `--name <text>`, `--owner <text>`, `--active` |
| `show <plan>` | `--save` |
| `search <text>` | `--kind plan,suite,case` (default all), `--top <n>` (default 50 per kind) |
| | `--plan <id>`: only the suites of this plan |
| `create`, `update <plan>` | `--name`, `--iteration <path>`, `--area <path>`, `--start`, `--end` |
| | `--description <file>`, `--state Active\|Inactive`, `--confirm` |
| `delete <plan>` | `--confirm` |
| `points <plan> [suite]` | `--case <id>` |
| `outcome <plan> [suite]` | `--outcome`, `--points <ids...>`, `--cases <ids...>`, `--confirm` |
| `suite show <plan> [suite]` | `--save` |
| `suite create <plan>` | `--name` (required), `--parent <suiteId>`, `--confirm` |
| | `--type static\|requirement\|query` (default static), `--requirement <id>`, `--query <wiql>` |
| `suite update <plan> [suite]` | `--name`, `--parent <suiteId>`, `--query <wiql>`, `--confirm` |
| `suite delete`, `suite add`, `suite remove` | `--cases <ids...>` (add and remove, required), `--confirm` |
| `case show <id>` | `--save` |
| `case create` | `--title`, `--steps <file>`, `--priority <n>`, `--state`, `--area`, `--iteration` |
| | `--assigned-to`, `--description <file>`, `--field <name=value>` (repeat) |
| | `--plan`, `--suite`, `--confirm` |
| `case update <id>` | The `case create` options except `--plan` and `--suite`, plus `--rev <n>` |
| `case delete <id>` | `--confirm` |

- A new plan without `--iteration` or `--area` gets the project's root iteration and root area.
- `--outcome` takes `passed`, `failed`, `blocked`, `notApplicable`, `paused`, `inProgress`, `unspecified`, or
  `active` to reset the points. `--cases` sets every configuration's point of each test case.
- `--description` and `--steps` read a file; `-` reads stdin. `--field` value `@file` reads a file.

Steps are a numbered markdown list (the form `case show` prints) or JSON
(`[{"action":"…","expected":"…"},{"sharedStepsId":123}]`):

```md
1. Open the sign-in page
   Expected: The form shows a user name field
2. Shared steps #12345
3. Press **Sign in**
```

In the markdown form, prefix an action line with `\` when it starts with `Expected:` or `Shared steps #` and is
literal text. `case show` escapes these markers itself.

**Know before you delete:** `testplan delete` and `suite delete` keep the plan or suite 14 days in the recycle bin;
the test cases stay. `case delete` deletes the test case for good, with its points and results. The counts in `show`
come from the preview `testplan/Count` route, then the 5.0 `test` area route; the line "no test case counts" means
neither answered.

### Project manifests (`maintenance`)

A manifest is a generated file that holds one part of the project's configuration, so code looks things up instead of
hard-coding generated ids such as `Custom.<guid>`. Each one has a `meta` block (organization, project, process, fetch
time, the command that regenerates it) and one payload. The kinds:

- `fields` (alias `get-fields`): per work item type, every field with its label, data type, identity flag,
  `alwaysRequired` and allowed values, and the type's states with their category.
- `workflow`: per work item type, the states a new item may start in (`initial`) and which state may follow which
  (`transitions`).
- `sprints`: every dated iteration by its iteration path, with its id, start and finish.
- `areas`: every area path.
- `queries`: every shared saved query by its folder path, with its id (My Queries are left out).
- `identities`: every member of the project's teams by unique name, with display name, id and teams.
- `tags`: every tag of the project.

```bash
# Print one manifest (md, json or ts)
tools azure-devops maintenance workflow --types "Bug,Task" -f md

# Write one as `export const AdoFields = {...} as const` (--name picks another identifier; a .json path writes JSON)
tools azure-devops maintenance fields --types "Bug,Task" --into src/ado-fields.generated.ts --name SampleAdoFields

# Write the default manifests into one folder as ado-<kind>.generated.ts, exports prefixed
tools azure-devops maintenance sync --into src/ado --prefix Sample --types "Bug,Task"

# Compare written manifests (files or folders) with ADO: prints each drift and exits 1
tools azure-devops maintenance check src/ado
```

| Command | Options |
| ------- | ------- |
| `fields`, `workflow` | `--types <list>` (default: every enabled type), `--into <file>`, `--check <file>` |
| | `--name <identifier>`, `-f md\|json\|ts` (default md) |
| `sprints`, `areas`, `queries`, `identities`, `tags` | `--into`, `--check`, `--name`, `-f md\|json\|ts` |
| `sync` | `--into <dir>` (required), `--only <kinds>`, `--prefix <identifier>`, `--types <list>` |
| | `-f ts\|json` (default ts): the format of the written files |
| `check <paths...>` | `--types <list>`: check these types instead of the ones in each file |

- `sync` writes every kind except `identities`, which needs an explicit `--only`. It creates the folder when missing.
- `--check <file>` on a single kind compares that file with ADO and exits 1 on drift, as `check` does.
- **Workflow in an inherited process.** The type's own transition map allows every state; the board enforces the
  order through process rules ("when System.State was X, disallow these states"), so those rules are subtracted. Rules
  with other conditions (a group, another field) are not applied and are listed in `conditionalRules`.
- Records are sorted by key, so a regenerated file differs only where ADO changed (and in `meta.fetchedAt`).
- `check` reads each file's kind from `meta.kind` (a file without one is a field manifest) and its work item types
  from the file, unless `--types` is given. It ignores `meta`.
- `findField(manifest, { type?, label?, value? })` in `lib/field-manifest.ts` returns the one matching field
  (reference name, label, type, allowed values, the types that have it). It returns `undefined` when none matches and
  throws when several match. A string label matches exactly, ignoring case; a RegExp is tested. `findFields` returns
  every match.

### Time logging (`timelog`)

TimeLog is a third-party extension for Azure DevOps. It must be installed in your organization. Agents that log time
from Timely or fill Clarity timesheets use the `/gt:timelog` plugin command, which drives these subcommands.

```bash
# Once per project: the API key, your user, the allowed types and states (interactive)
tools azure-devops timelog configure

# The time types of the organization
tools azure-devops timelog types
tools azure-devops timelog types --format json

# Entries of one work item, one day, or a range
tools azure-devops timelog list -w 12345
tools azure-devops timelog list -w 12345 --format md
tools azure-devops timelog list --day 2026-02-04 --user @me
tools azure-devops timelog list --from 2026-02-01 --to 2026-02-08 --format json

# Add an entry (default date: today)
tools azure-devops timelog add -w 12345 -h 2 -t "Development"
tools azure-devops timelog add -w 12345 -h 1 -m 30 -t "Code Review" -c "PR review"
tools azure-devops timelog add -w 12345 -h 0 -m 30 -t "Test"
tools azure-devops timelog add -w 12345 -h 2 -t "Development" --date 2026-02-04
tools azure-devops timelog add -i                 # interactive
tools azure-devops timelog add -w 12345 -i

# Delete an entry and roll back Remaining and Completed Work
tools azure-devops timelog delete <timeLogId> --dry-run
tools azure-devops timelog delete <timeLogId> --yes
tools azure-devops timelog delete <timeLogId> --no-effort --yes   # the row only
tools azure-devops timelog delete -w 12345                         # pick from a list (needs a terminal)

# One month with a summary
tools azure-devops timelog export-month --month 2 --year 2026
tools azure-devops timelog export-month --month 2 --format json --output feb.json

# Bulk import
tools azure-devops timelog import entries.json --dry-run
tools azure-devops timelog import entries.json
```

| Subcommand | Options |
| ---------- | ------- |
| `add` | `-w, --workitem <id>`, `-h, --hours <hours>`, `-m, --minutes <minutes>`, `-t, --type <type>` |
| | `-d, --date <YYYY-MM-DD>`, `-c, --comment <text>`, `-i, --interactive` |
| `list` | `-w, --workitem <id>`, `--day <date>`, `--from <date>`, `--to <date>` |
| | `--user <name>` (repeat; `@me`), `--format ai\|md\|json\|table` (default ai) |
| `types` | `--force` (skip the cache), `--format ai\|json` |
| `delete [timeLogId]` | `-w, --workitem <id>` (the picker, or a hint for a bare id), `--no-effort`, `--dry-run` |
| | `--yes` (required without a terminal) |
| `import <file>` | `--dry-run` |
| `configure` | `--allowed-work-item-types <types>`, `--deprioritized-states <states>` |
| | `--allowed-states-for-type <Type:State1,State2>` (repeat) |
| `export-month` | `--month <1-12>` (required), `--year <n>` (default: this year), `--format table\|json` |
| | `--output <file>`, `--user <id>` |
| `prepare-import add` | `--from <date>`, `--to <date>`, `--name <name>`, `--entry <json>` (required) |
| `prepare-import list` | `--name <name>` (required), `--format table\|json` |
| `prepare-import remove` | `--name <name>`, `--id <uuid>` (both required) |
| `prepare-import clear` | `--name <name>` (required) |

**`-h` is `--hours` in `timelog add`**, so its help is `timelog add --help` (or `-?`), not `-h`.

#### Hours and minutes

The TimeLog API counts minutes:

- `--hours 2` is 120 minutes.
- `--hours 1 --minutes 30` is 90 minutes.
- `--minutes 30` alone is an error, because it is ambiguous.
- `--hours 0 --minutes 30` is 30 minutes, stated on purpose.

#### `timelog configure`

Without flags it runs interactive prompts:

1. When the API key (`functionsKey`) is missing, it offers to fetch it from the Azure DevOps Extension Data API. When
   that fails, you can paste it.
2. When the default user is missing, it lists the team members to pick from, or asks for the user by hand.
3. It sets the allowed work item types, the allowed states per type, and the deprioritized states.

Everything goes into the `timelog` block of `.claude/azure/config.json`. The flags change only the types and states,
without prompts, which is the form for scripts and agents:

```bash
tools azure-devops timelog configure --allowed-work-item-types "Bug,Task" --allowed-states-for-type "Task:In Progress"
tools azure-devops timelog configure --deprioritized-states "Closed,Done,Resolved"
```

An empty `--allowed-work-item-types ""` or `--deprioritized-states ""` clears the setting. When the prompts cannot
run (an agent), set the user by hand:

```json
{
  "timelog": {
    "functionsKey": "<auto-fetched>",
    "defaultUser": {
      "userId": "<your-azure-ad-object-id>",
      "userName": "<Your Display Name>",
      "userEmail": "alice@example.com"
    }
  }
}
```

#### `timelog list`

- `-w <id>` alone lists that work item's entries.
- `--day`, or `--from` with an optional `--to`, lists entries across work items for the project; add `-w` to narrow it.
  A range needs `--from` (or `--day`). `--since` and `--upto` are also accepted as aliases of `--from` and `--to`.
- `--user` filters by a part of the user name; `@me` means the configured `defaultUser`.

#### Effort: Remaining and Completed Work

`timelog add` and `timelog import` also update the work item: Remaining Work goes down and Completed Work goes up by
the logged hours, both floored at 0. A failed update is a warning; the entry stays. Each update is appended to the
effort journal, `~/.genesis-tools/azure-devops/effort-journal.jsonl` (the values before and after, and the entry ids).

`timelog delete` uses that journal to roll the fields back:

- **Exact**: the journal record covers only this entry, and the fields still hold the values it wrote. The fields
  return to the journalled values before the add.
- **Approximate**: no record (an entry created before the journal existed), a record that covers several imported
  entries, or fields that changed since. Remaining goes up and Completed goes down by the entry's hours, floored at 0,
  and the command prints why it is approximate.

Run `--dry-run` first to see the planned transition. `--no-effort` deletes the entry and leaves both fields alone.

When `delete` cannot find the entry's work item or minutes, it deletes nothing and exits 1. Pass `-w <id>` with the
time log id as a hint, or `--no-effort` to delete only the row:

```bash
tools azure-devops timelog delete <timeLogId> -w 12345 --yes
```

#### Work item type precheck

`add`, `import` and `prepare-import add` check each work item against `allowedWorkItemTypes` before they create
anything. A common setting is `"Bug,Task"`, which keeps time off User Stories and Features. A work item of a type that
is not allowed is redirected to its single best child of an allowed type:

- The children of an allowed type are collected. When `allowedStatesPerType` lists a child's type, the child must be
  in one of those states.
- No matching child: error.
- Several matching children are ranked in three tiers, and only the best tier that is not empty counts:
  1. Not in a deprioritized state, and assigned to the configured default user.
  2. Not in a deprioritized state, assigned to anyone.
  3. In a deprioritized state, most recently changed first.
- Exactly one child in that tier: the entry goes to it, with a warning.
- More than one: error, with the list to choose from.

Deprioritized states default to `Closed`, `Done`, `Resolved` and `Removed`; change them with
`timelog configure --deprioritized-states`. The import prints a summary of passed, redirected and failed entries.

**Without `allowedWorkItemTypes`** the commands differ. `add` and `import` skip the precheck and accept any type;
`import` prints a note that it skipped it. `prepare-import add` refuses every entry ("allowedWorkItemTypes not
configured") and exits 1 until `timelog configure --allowed-work-item-types` sets the types. `timelog configure`
shows the unset list as "not configured (all types allowed)".

#### Import files and `prepare-import`

An import file holds an `entries` array:

```json
{
  "entries": [
    { "workItemId": 12345, "hours": 2, "timeType": "Development", "date": "2026-02-04", "comment": "Implemented feature X" },
    { "workItemId": 12346, "hours": 1, "minutes": 30, "timeType": "Code Review", "date": "2026-02-04", "comment": "Review of owner/repo#42" }
  ]
}
```

`prepare-import` builds such a file one validated entry at a time, so you can review it before anything is sent:

```bash
tools azure-devops timelog prepare-import add --from 2026-02-01 --to 2026-02-08 \
  --entry '{"workItemId": 12345, "date": "2026-02-04", "hours": 2, "timeType": "Development"}'
tools azure-devops timelog prepare-import list --name 2026-02-01.2026-02-08
tools azure-devops timelog prepare-import remove --name 2026-02-01.2026-02-08 --id <uuid>
tools azure-devops timelog prepare-import clear --name 2026-02-01.2026-02-08
tools azure-devops timelog import ~/.genesis-tools/azure-devops/cache/prepare-import/2026-02-01.2026-02-08.json
```

- The file name comes from `--from` and `--to` as `<from>.<to>`, or from `--name`. Files live in
  `~/.genesis-tools/azure-devops/cache/prepare-import/`.
- Each entry is checked against the entry schema and runs the precheck before it is added.
- Leave `workItemTitle` out unless you have the exact title. `prepare-import add` fills it in, and
  `prepare-import list` writes any title still missing back to the staged file. `import --dry-run` shows the filled
  titles in its preview but does not change the input file.
- `prepare-import list` treats a staged file that has not changed for 30 days as missing ("No prepare-import file
  found"), but the file stays on disk. Run `timelog import` on its path instead.
- Run these commands from the project folder that has `.claude/azure/config.json`.

## Workflows

Daily standup:

```bash
tools azure-devops query <your-active-items-query-id>   # new and updated items are highlighted
tools azure-devops workitem 12345,12346 --force          # full details of what changed
```

Sprint planning:

```bash
tools azure-devops query <sprint-query-id> --download-workitems --category sprint-2026-01
tools azure-devops query <sprint-query-id> --severity A,B --download-workitems --category sprint-2026-01
```

Bug triage:

```bash
tools azure-devops dashboard <bugs-dashboard-id>
tools azure-devops query <active-bugs-query-id> --state Active --download-workitems --category bugs
tools azure-devops query <critical-bugs-query-id> --severity A --download-workitems --category critical-bugs --task-folders
```

Feature work:

```bash
tools azure-devops query <feature-query-id> --download-workitems --category react19 --task-folders
# tasks/react19/12345/12345-Feature-Title.json and .md
tools azure-devops workitem 12345 --force                # later: the category is remembered
```

A bug with a HAR capture:

```bash
tools azure-devops workitem 12345 --attachments-suffix .har --output-dir ~/Projects/app/har
tools har-analyzer load ~/Projects/app/har/12345-capture.har
```

## Output formats

Most commands take `ai`, `md` or `json`; `ancestors`, `tree`, `comment`, `wiki` and `history` use `table|json` (or
their own names, listed above).

- **`ai`** (default): summary tables, the changes since the last run with before and after values, relative times and
  next steps.
- **`md`**: plain markdown tables for documents.
- **`json`**: the data for programs. `query -f json` prints `{ "items": [...], "changes": [...] }`, with `changes`
  empty on the first run of a query.

```text
# Query Results: d6e14134-9d22-4cbb-b897-b1514f888667

Last checked: 5 minutes ago

Total: 12 work items

| ID | Title | State | Severity | Assignee |
|-----|-------|-------|----------|----------|
| 12345 | Fix login bug | Active | A | Jane Doe |
...

## Changes Detected (2)

### NEW: #12346 - Add dark mode
- State: New
- Severity: B
- Assignee: unassigned

### UPDATED: #12345 - Fix login bug
- State: Active → Development
- Assignee: unassigned → Jane Doe
```

## How it works

- **Azure DevOps REST API.** Every request carries a token from `az account get-access-token` for the Azure DevOps
  resource `499b84ac-1321-427f-aa17-267ca6975798`. The tool keeps the token in memory and asks `az` for a new one
  after about 4 minutes; it never reads the token's own expiry time. There is no PAT and no stored secret for
  ADO itself.
- **Other hosts.** Wiki search calls `almsearch.dev.azure.com`. `timelog configure` reads the TimeLog key from the
  Extension Data API (`extmgmt.dev.azure.com`). Time entries go to the TimeLog extension's own API, authenticated
  with that key.
- **Needs.** The Azure CLI with the `azure-devops` extension, a signed-in account with access to the project, and
  Bun. No macOS permission, no GenesisTools.app. The tool makes no paid calls.

### Where data lives

Per project, in `.claude/azure/` of the working directory:

```text
.claude/azure/
├── config.json                      # project configuration (see Configuration)
├── tasks/
│   ├── {id}-{Slug-Title}.json       # flat (default)
│   ├── {id}-{Slug-Title}.md
│   ├── {id}/                        # --task-folders
│   │   ├── {id}-{Slug-Title}.json
│   │   └── {id}-{Slug-Title}.md
│   ├── {category}/                  # --category
│   │   ├── {id}-{Slug-Title}.json
│   │   └── {id}/
│   │       └── {id}-{Slug-Title}.json
│   └── created/                     # templates from workitem-create
├── wiki/<wiki>/<pageId>/            # wiki get --images
└── testplans/                       # testplan … --save
```

The config is found by a search (below), but `tasks/`, `wiki/` and `testplans/` are created in the **working
directory's** `.claude/azure/`. With `--config` or `AZURE_DEVOPS_CONFIG` they go next to that config file instead.

Global, in `~/.genesis-tools/azure-devops/`:

```text
~/.genesis-tools/azure-devops/
├── effort-journal.jsonl              # every Remaining/Completed change made by timelog add and import
└── cache/
    ├── workitem-{id}.json            # 365 days; served without a request for 5 minutes after a fetch
    ├── query-{id}.json               # 180 days; the previous run, for change detection
    ├── dashboard-{id}.json           # 180 days
    ├── queries-list.json             # 30 days; saved query names for name matching
    ├── projects.json                 # 30 days; the project list of interactive create
    ├── team-members-{projectId}.json # 30 days; the team roster
    ├── timetypes-{projectId}.json    # 7 days; TimeLog types
    ├── type-definitions-{projectId}.json  # 7 days; work item types and their colours
    ├── timelog/{id}.json             # 5 minutes; a work item's time entries
    └── prepare-import/               # staged TimeLog entries
```

### Caching

- **Work items** stay in the cache for 365 days. A copy fetched less than 5 minutes ago is used with no request, and
  the output says so: `📦 From cache (2 minutes ago) - use --force to refresh`. A query run also reuses a cached item
  whenever its revision is unchanged. The work item cache holds metadata and sections, not the full task file.
- **Sections** inside a work item cache entry: history and comments are refetched after 7 days; links (for `tree`)
  after 5 minutes.
- **Queries** keep the previous result for 180 days, which is what change detection compares against.
- **`--force`** bypasses the work item and query caches. It does not refresh the saved query list.
- Adding or importing time entries evicts that work item's cached time entries.

## Configuration

`configure` writes `.claude/azure/config.json`; `timelog configure` adds the `timelog` block.

```json
{
  "org": "https://dev.azure.com/MyOrg",
  "project": "MyProject",
  "projectId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "orgId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "apiResource": "499b84ac-1321-427f-aa17-267ca6975798",
  "team": "Payments Team",
  "timelog": {
    "functionsKey": "<auto-fetched>",
    "defaultUser": { "userId": "<id>", "userName": "<Your Display Name>", "userEmail": "alice@example.com" },
    "allowedWorkItemTypes": ["Bug", "Task"],
    "allowedStatesPerType": { "Task": ["In Progress"] },
    "deprioritizedStates": ["Closed", "Done", "Resolved"]
  }
}
```

| Key | Meaning |
| --- | ------- |
| `org` | Organization URL, taken from the URL you passed |
| `project` | Project name, URL-decoded |
| `projectId` | Project GUID, fetched by `configure` |
| `orgId` | Organization GUID, fetched by `configure`; `timelog` needs it |
| `apiResource` | The Azure DevOps OAuth resource id (the same for every organization) |
| `team` | Optional. Stored when the URL is a board or backlog URL; used by `iterations` and `sprint` |
| `timelog.functionsKey` | The TimeLog API key |
| `timelog.defaultUser` | Your TimeLog identity (`userId`, `userName`, `userEmail`); `@me` resolves to it |
| `timelog.allowedWorkItemTypes` | Types time may be logged on |
| `timelog.allowedStatesPerType` | Per type, the states a child must be in for the precheck |
| `timelog.deprioritizedStates` | States that rank last when the precheck picks a child |

**Which config is used:** `--config <path>`, then `AZURE_DEVOPS_CONFIG`, then a search for
`.claude/azure/config.json` in the working directory and up to three parent folders. So the tool also runs from a
subfolder of the project. A path from `--config` or the variable that is missing, is a folder, or cannot be read is an
error; the tool never falls back to the search. With an explicit path, `configure` writes the config there.

```bash
tools azure-devops --config ~/Projects/app/.claude/azure/config.json workitem 12345
AZURE_DEVOPS_CONFIG=~/Projects/app/.claude/azure/config.json tools azure-devops workitem 12345
```

| Environment variable | Effect |
| -------------------- | ------ |
| `AZURE_DEVOPS_CONFIG` | Path of the config file, as `--config` |
| `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1` | Read by the Azure CLI: skip TLS checks behind an intercepting proxy |
| `REQUESTS_CA_BUNDLE` | Read by the Azure CLI: a CA bundle that trusts your proxy |

## For agents

- **JSON everywhere.** `workitem`, `query`, `dashboard`, `sprint`, `iterations`: `-f json`. `ancestors`, `tree`,
  `comment list`, `wiki …`: `--format json`. `history search`, `history mentions`: `-o json`; `history show`: `-f
  json`; `history activity`: `-o json`. `testplan …`: `-f json`. The `maintenance` manifest kinds (`fields`,
  `workflow`, `sprints`, `areas`, `queries`, `identities`, `tags`): `-f json`; `maintenance check` has no `-f`, and
  `-f` of `maintenance sync` sets the format of the written files. `timelog list`, `timelog types`, `export-month`,
  `prepare-import list`: `--format json`. `workitem-update`: `--json`. `query -f json` is `{ items, changes }`.
- **Writes are explicit.** `workitem-update` and every `testplan` write print what they would send until `--confirm`.
  `comment delete` and `timelog delete` need `--yes` without a terminal. `timelog delete --dry-run` and
  `timelog import --dry-run` change nothing on the server.
- **Interactive prompts** (`workitem-create -i`, `timelog add -i`, `timelog configure` without flags, `timelog delete
  -w` without an id) need a terminal. Use the flag forms instead.
- **Exit codes.** 0 on success. 1 on any error, including: a missing login or config (the message names the missing
  step), an ambiguous sprint name, manifest drift in `maintenance check` or `--check`, a `workitem-update` read-back
  that differs, `history mentions` over `--max-candidates`, a `timelog delete` that cannot find the work item or
  minutes, and `prepare-import add` without `allowedWorkItemTypes`.
- **Plugin skill.** `gt:azure-devops` (`plugins/genesis-tools/skills/azure-devops/SKILL.md`) teaches an agent these
  commands and the analysis workflow for a work item (fetch with `--task-folders --images`, read the images, explore
  the code, write `<id>-<Title>.analysis.md` beside the task file). It triggers on work item, query, dashboard,
  sprint, wiki, comment, history, parent chain, test plan and Azure DevOps URL requests. Time logging goes through the
  `/gt:timelog` command.
- Use `wiki get`, `comment` and `testplan` instead of a hand-built `az` token and `curl`.

## Troubleshooting

**"No Azure DevOps configuration found".** No config in the working directory or three folders above it. Run
`configure` with any URL of the project, or pass `--config <path>`.

**"Azure CLI (az) was not found on PATH".** Install the Azure CLI. When it is installed, open a new terminal so it
picks up the new PATH.

**"Azure CLI Authentication Required"**, AADSTS errors, or an expired MFA session. Sign in again:

```bash
az login --allow-no-subscriptions --use-device-code
```

When that fails with `AADSTS530036` (Conditional Access blocks the device-code flow), use the browser flow with the
Azure DevOps scope:

```bash
az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default --allow-no-subscriptions
```

When the error names a tenant, the printed commands carry `--tenant "<id>"`.

**SSL certificate errors** (`CERTIFICATE_VERIFY_FAILED`, self-signed certificate). A proxy intercepts the traffic.
Close the proxy tool (Proxyman, Charles, mitmproxy), or trust its CA with `REQUESTS_CA_BUNDLE=<bundle>`, or as a last
resort set `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1`.

**"Failed to get project info"** during `configure`. Check `az account show`, check that the project name matches
exactly (it is case-sensitive), and check that your account can open the project.

**"Organization ID missing from config"** from a `timelog` command. The config predates `orgId`; run `configure`
again with a project URL. It keeps your `timelog` block.

**"TimeLog configuration not found"** or **"TimeLog user not configured"**. Run `timelog configure` in a terminal, or
add `functionsKey` and `defaultUser` to the `timelog` block by hand.

**"Azure DevOps config … does not parse, so it was left untouched".** `configure` refuses to replace a broken config,
because it may hold the only copy of the TimeLog key. Fix or move the file, then configure again.

**A query name finds the wrong query, or a new query is not found.** The saved query list is cached 30 days and
`--force` does not refresh it. Pass the query id or URL, or delete `queries-list.json` in
`~/.genesis-tools/azure-devops/cache/`.

**Stale data.** Use `--force`. To start over, delete `~/.genesis-tools/azure-devops/cache/`; the effort journal beside
it is not a cache, so keep it.

**A task file was not found** after you moved it. The tool looks in `tasks/`, `tasks/<category>/`, `tasks/<id>/` and
`tasks/<category>/<id>/`. A file elsewhere is not found, and a new one is written where the current settings put it.

**`VS402612` about `@CurrentIteration`.** Use `sprint` instead of the saved query; see "Why not `@CurrentIteration`".

## Related

- [`tools clarity`](../clarity/README.md): fills Clarity timesheets from TimeLog entries and routes work items through
  `ancestors`.
- [`tools timely`](../timely/README.md): the tracked activity to check before you log time.
- [`tools git`](../git/README.md): `git commits` lists the commits that reference a work item, with the ids extracted.
- [`tools gitlab`](../gitlab/README.md): `pr stale` reads linked work items through `workitem`.
- [`tools har-analyzer`](../har-analyzer/README.md): analyzes a `.har` attachment downloaded with
  `--attachments-suffix .har`.
- [`docs/README.md`](docs/README.md): reference for the `az` CLI and the REST API: WIQL syntax, the history APIs, API
  discovery and the TimeLog API.
- [Azure DevOps CLI](https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops),
  [Azure CLI installation](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and the
  [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/).
