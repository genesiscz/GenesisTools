# PHPStan Error Pattern Analyzer

Analyzes PHPStan errors, identifies patterns, creates documentation tasks, and spawns an AI agent to provide fix solutions.

## Prerequisites

- PHPStan log file exists: `phpstan7.log` (JSON format from `vendor/bin/phpstan analyze --error-format=json > phpstan7.log`)
- `jq` command available for JSON processing

## Step-by-Step Process

### Step 1: Generate Error Patterns from PHPStan Log

Run the jq command to extract and group common error patterns with count >= 10 (limit to 100 patterns):

```bash
cat phpstan7.log | jq -r '
[
  .files | to_entries | .[] |
  .key as $filepath |
  .value.messages | .[] |
  {
    pattern: (
      .message |
      gsub("App\\\\[A-Za-z\\\\]+"; "App\\<Class>") |
      gsub("Illuminate\\\\[A-Za-z\\\\]+"; "Illuminate\\<Class>") |
      gsub("Stancl\\\\[A-Za-z\\\\]+"; "Stancl\\<Class>") |
      gsub("Brick\\\\[A-Za-z\\\\]+"; "Brick\\<Class>") |
      gsub("Spatie\\\\[A-Za-z\\\\]+"; "Spatie\\<Class>") |
      gsub("Carbon\\\\[A-Za-z\\\\]+"; "Carbon\\<Class>") |
      gsub("\\$[a-zA-Z_][a-zA-Z0-9_]*"; "$<var>") |
      gsub("#[0-9]+"; "#<N>") |
      gsub("[0-9]+"; "<num>")
    ),
    file: $filepath,
    message: .message,
    line: .line
  }
] |
group_by(.pattern) |
map({
  pattern: .[0].pattern,
  count: length,
  files: (
    group_by(.file) |
    map({
      file: .[0].file,
      count: length,
      messages: map({message: .message, line: .line})
    })
  )
}) |
sort_by(.count) |
reverse |
.[] |
select(.count >= 10)
' | jq -s '.[0:100]' > /tmp/phpstan_patterns.json
```

**Output**: `/tmp/phpstan_patterns.json` containing normalized error patterns

### Step 2: Create Documentation Directory Structure

```bash
mkdir -p docs/tasks/phpstan
```

### Step 3: Generate Task Markdown Files

Run the provided script to create individual markdown files for each pattern:

```bash
scripts/create_phpstan_docs.sh
```

Or manually generate with:

```bash
cat /tmp/phpstan_patterns.json | jq -r 'to_entries[] | .key as $i | .value | "Pattern \($i+1): \(.pattern) (\(.count) occurrences)"'
```

For each pattern, create file `docs/tasks/phpstan/000N-<pattern-name>.md` with:
- Pattern summary
- Error count and affected files
- Detailed JSON of all occurrences
- Placeholder sections for analysis and fix strategy

**Output**: 5 markdown task files in `docs/tasks/phpstan/`

### Step 4: Spawn Agent to Analyze Patterns and Fill Solutions

Launch a single general-purpose agent with the entire pattern analysis data to provide fix strategies for all patterns:

```
/spawn-agent

Agent Type: general-purpose
Model: opus

Task Description:
"You are analyzing PHPStan errors for a Laravel multi-tenant booking platform (Reservine).

I have 5 error patterns extracted from phpstan7.log. For EACH pattern, provide:

1. **Root Cause Analysis** - Why this error occurs in the codebase
2. **Problem Locations** - Specific files and line numbers affected
3. **Fix Strategy** - Step-by-step solution approach
4. **Code Examples** - Before/after code showing the fix
5. **Critical Files** - Which files need changes

Here are the patterns (from worst to best):

[INSERT FULL /tmp/phpstan_patterns.json CONTENT HERE]

Additional Context:
- Framework: Laravel 11 with Spatie LaravelData for DTOs
- Multi-tenant: Uses stancl/tenancy package
- Type Safety: PHPStan level 7 (strict)
- Architecture: Models extend BaseModel, Services with DI, DTOs for Request/Response

For each pattern, provide analysis in a structured format that can be directly used to update the task markdown files."

Additional Instructions:
- Start with Pattern 1 (highest count: 72 errors)
- Work down to Pattern 5 (10 errors)
- Format output as markdown sections ready to copy into task files
- Focus on practical, implementable solutions
- Consider codebase patterns from CLAUDE.md
```

### Step 5: Review Agent Output

The agent will provide:
- Complete analysis for each pattern
- Root cause explanations
- Concrete fix strategies with code examples
- List of critical files to modify

### Step 6: Update Task Files

Copy the agent's analysis into each corresponding task file:

```bash
# For each pattern file:
docs/tasks/phpstan/0001-...md    # Update with Pattern 1 analysis
docs/tasks/phpstan/0002-...md    # Update with Pattern 2 analysis
docs/tasks/phpstan/0003-...md    # Update with Pattern 3 analysis
docs/tasks/phpstan/0004-...md    # Update with Pattern 4 analysis
docs/tasks/phpstan/0005-...md    # Update with Pattern 5 analysis
```

## Key Files

- **Pattern Source**: `phpstan7.log` (input)
- **Temporary Data**: `/tmp/phpstan_patterns.json` (intermediate)
- **Script**: `scripts/create_phpstan_docs.sh` (generates markdown templates)
- **Task Files**: `docs/tasks/phpstan/*.md` (final analysis documents)

## Expected Output

After completing all steps, you'll have:

1. ✅ Normalized error patterns (count and affected files)
2. ✅ 5 markdown task files with detailed pattern information
3. ✅ Complete analysis with root causes and fix strategies
4. ✅ Ready-to-implement code solutions for each pattern
5. ✅ Prioritized list of critical files to modify

## Typical Workflow

```bash
# 1. Generate patterns
cat phpstan7.log | jq -r '[...]' | jq -s '.[0:100]' > /tmp/phpstan_patterns.json

# 2. Create directory
mkdir -p docs/tasks/phpstan

# 3. Generate task files
scripts/create_phpstan_docs.sh

# 4. Spawn agent (in Claude Code):
#    /phpstan-analyzer (this command)
#    → Follow the agent spawning instructions

# 5. Review agent output and update task files manually

# 6. Begin fixing errors based on analysis
```

## Tips

- **Pattern Normalization**: The jq command replaces class names and variables with placeholders (`App\<Class>`, `$<var>`) to group similar errors
- **Count Filter**: Only patterns with 10+ occurrences are analyzed (reduces noise)
- **Agent Context**: Provide the full patterns JSON to the agent for comprehensive analysis
- **Iterative Approach**: Start with highest-count patterns (biggest impact)
- **Documentation**: Keep task files updated as solutions are implemented
