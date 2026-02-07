# WIQL (Work Item Query Language) Syntax Reference

WIQL is used to define queries for Azure DevOps work items via REST API or hyperlinks. Queries have a maximum length of 32-K characters.

## Basic Query Structure

WIQL queries consist of five main clauses:

```
SELECT [field1], [field2], ...
FROM workitems | workitemLinks
WHERE [field] operator value
ORDER BY [field] ASC | DESC
ASOF 'date-time'
```

### SELECT Clause
- Specifies fields to return
- Use reference names: `[System.Id]`, `[System.Title]`
- Or friendly names (with spaces, use brackets): `[Assigned To]`
- Names without spaces don't require brackets: `ID, Title`

### FROM Clause
- `FROM workitems` - Returns work items
- `FROM workitemLinks` - Returns link relationships between work items

### WHERE Clause
- Specifies filter conditions
- Case-insensitive
- Supports logical operators: `AND`, `OR`, `NOT`
- Use parentheses to control evaluation order

### ORDER BY Clause
- Sorts results by one or more fields
- `ORDER BY [System.ChangedDate] DESC`
- Supports `ASC` (ascending) or `DESC` (descending)

### ASOF Clause
- Filters based on historical state at a specific date/time
- Useful for reporting on past assignments/states
- Format: `ASOF '01-05-2025 00:00:00.0000000'`
- If no time specified, defaults to midnight

## Field Types & Supported Operators

| Field Type | Operators |
|---|---|
| Boolean | `=`, `<>`, `=[Field]`, `<>[Field]` |
| DateTime | `=`, `<>`, `>`, `<`, `>=`, `<=`, `In`, `Not In`, `Was Ever` |
| Double, GUID, Integer | `=`, `<>`, `>`, `<`, `>=`, `<=`, `In`, `Not In`, `Was Ever` |
| Identity | `=`, `<>`, `>`, `<`, `>=`, `<=`, `Contains`, `Not Contains`, `In`, `Not In`, `In Group`, `Not In Group`, `Was Ever` |
| PlainText | `Contains Words`, `Not Contains Words`, `Is Empty`, `Is Not Empty` |
| String | `=`, `<>`, `>`, `<`, `>=`, `<=`, `Contains`, `Not Contains`, `In`, `Not In`, `In Group`, `Not In Group`, `Was Ever` |
| TreePath | `=`, `<>`, `In`, `Not In`, `Under`, `Not Under` |

## Key Operators

### Basic Comparison Operators
```
= Equal
<> Not equal
> Greater than
< Less than
>= Greater than or equal
<= Less than or equal
```

### String Operators
```
Contains     - Searches for substring in field value
Not Contains - Negation of Contains
[Field]      - Compare against another field value
```

### Collection Operators
```
IN ('value1', 'value2', 'value3')     - Matches any value in list
NOT IN (...)                           - Negation of IN
UNDER 'path\subtree'                  - For Area/Iteration paths; matches subtree
NOT UNDER 'path\subtree'              - Negation of UNDER
```

### History Operators
```
EVER [Field] = value          - Field has ever contained this value (across all revisions)
AND EVER / OR EVER            - Logical modifiers for EVER clauses
NOT [Field] EVER = value      - Negation (can't negate EVER directly)
```

### Group Operators
```
IN GROUP 'groupname'          - For Identity fields
NOT IN GROUP 'groupname'
```

## Macros & Variables

| Macro | Purpose |
|---|---|
| `@Me` | Current user's alias (for identity fields) |
| `@Project` | Current project name |
| `@CurrentIteration` | Current sprint for selected team |
| `@Today` | Current date at midnight |
| `@Today - n` | n days before today (e.g., `@Today - 7`) |
| `@Today + n` | n days after today |
| `@StartOfDay` | Midnight of current day |
| `@StartOfWeek` | Start of current week (midnight) |
| `@StartOfMonth` | First day of current month (midnight) |
| `@StartOfYear` | January 1 of current year (midnight) |
| `@StartOfMonth - 3` | 3 months before month start |
| `@StartOfYear('+3M') - 1` | 3 months into year, minus 1 day |
| `[Any]` | Any value defined for a field |
| `@customMacro` | Custom macros from API context parameter |

**Modifier Syntax:** `@StartOf...(+/-)nn(y\|M\|w\|d\|h\|m))`
- Units: `y`=year, `M`=month, `w`=week, `d`=day, `h`=hour, `m`=minute
- Example: `@StartOfMonth('+1M') - 1` = last day of next month

## Date & Time Formats

### Locale-Based Format
Uses your user profile settings. Examples:
```
'01-03-2025'
'01-03-2025 14:30:01'
'01-03-2025 14:30:01 GMT'
```

### ISO 8601 Format (Locale-Independent)
```
'2025-01-03T00:00:00.0000000'
'2025-01-18T14:30:01.0000000'
```

**Note:** If no time specified and `dayPrecision=false` (default), time defaults to midnight (00:00:00).

## Common Patterns

### Current User's Items
```sql
WHERE [System.AssignedTo] = @Me
```

### Recently Changed
```sql
WHERE [System.ChangedDate] >= @Today - 30
```

### By Type & State
```sql
WHERE [System.WorkItemType] IN ('Bug', 'Feature', 'User Story')
AND [System.State] = 'Active'
```

### In Specific Area
```sql
WHERE [System.AreaPath] UNDER 'MyProject\Backend'
```

### Was Ever Assigned
```sql
WHERE EVER [System.AssignedTo] = 'User Name <user@example.com>'
```

### Multi-Condition with Grouping
```sql
WHERE
    [System.TeamProject] = @Project
    AND (
        [System.WorkItemType] = 'Bug'
        AND (
            [System.AssignedTo] = @Me
            OR [System.CreatedBy] = @Me
        )
    )
```

### Historical Query (As Of Date)
```sql
SELECT [System.Id], [System.Title], [System.AssignedTo]
FROM workitems
WHERE [System.IterationPath] = 'MyProject\Sprint 5'
ASOF '2025-01-15 00:00:00.0000000'
```

### Priority with Sort
```sql
SELECT [System.Id], [System.Title], [Microsoft.VSTS.Common.Priority]
FROM workitems
WHERE [System.TeamProject] = @Project
AND [Microsoft.VSTS.Common.Priority] <> ''
ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.CreatedDate] DESC
```

## Link Queries (workitemLinks)

Use `FROM workitemLinks` to query relationships. Available modes:

```
MODE (MustContain)   - Default: source, target, and link all match
MODE (MayContain)    - Source and link match, target may not exist
MODE (DoesNotContain)- Source matches, no linked items satisfy target criteria
MODE (Recursive)     - For hierarchy trees (Hierarchy-Forward link type only)
```

Example - Find parent-child relationships:
```sql
SELECT [Source].[System.Id], [Target].[System.Id], [System.Links.LinkType]
FROM workitemLinks
WHERE
    [Source].[System.TeamProject] = @Project
    AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
    AND [Target].[System.State] <> 'Closed'
MODE (MustContain)
```

### Available Link Types
- `System.LinkTypes.Hierarchy-Forward` (parent-child)
- `System.LinkTypes.Related`
- `System.LinkTypes.Dependency-Predecessor`
- `System.LinkTypes.Dependency-Successor`
- `Microsoft.VSTS.Common.Affects-Forward` (CMMI)

## Field References

Common system field reference names:
- `System.Id` - Work item ID
- `System.Title` - Title
- `System.State` - Current state
- `System.WorkItemType` - Type (Bug, Feature, etc.)
- `System.AssignedTo` - Assigned user
- `System.CreatedBy` - Created by user
- `System.CreatedDate` - Creation date
- `System.ChangedDate` - Last changed date
- `System.TeamProject` - Project name
- `System.AreaPath` - Area classification
- `System.IterationPath` - Sprint/iteration
- `System.Description` - Description text
- `System.Tags` - Tags (semicolon-separated)

### Custom Fields
Reference format: `Custom.FieldName` (spaces removed, no special chars)
- Friendly: "Request Type" → Reference: `Custom.RequestType`
- Friendly: "Scope Estimate" → Reference: `Custom.ScopeEstimate`

## Important Notes

- **Case-insensitive:** WIQL is not case-sensitive
- **32-K limit:** Queries cannot exceed 32,768 characters
- **Performance:** Use specific WHERE filters, minimize result sets, avoid unbounded searches
- **Date zones:** If no timezone specified, uses local client timezone
- **Nesting:** Can nest macros with offsets: `@StartOfYear('+3M') - 1`
- **Cannot negate EVER:** Use `NOT [Field] = value` instead
- **Tree queries:** `ORDER BY` and `ASOF` incompatible with `MODE (Recursive)`
- **Quote literals:** String/DateTime values must be quoted (single or double)

## Quick Examples

**Active bugs in current sprint assigned to me:**
```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @Project
AND [System.WorkItemType] = 'Bug'
AND [System.State] = 'Active'
AND [System.IterationPath] = @CurrentIteration
AND [System.AssignedTo] = @Me
```

**Items modified last 7 days:**
```sql
SELECT [System.Id], [System.Title], [System.ChangedDate]
FROM workitems
WHERE [System.TeamProject] = @Project
AND [System.ChangedDate] >= @Today - 7
ORDER BY [System.ChangedDate] DESC
```

**All items ever worked on by user:**
```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @Project
AND EVER [System.AssignedTo] = 'John Doe <john@example.com>'
```
