# Fix PHPUnit Tests

Analyze failing PHPUnit tests and spawn parallel agents to fix them efficiently.

## Usage

```
/fix-phpunit-tests <test-output>     # Paste failed test output directly
/fix-phpunit-tests last-failed       # Auto-fetch last failed tests
```

## Input: $ARGUMENTS

## Process

### Step 1: Gather Test Failures

**If input is `last-failed` (or anything like "take all last failed tests", "get all last failed tests", "get all failed tests", "get all failed tests from the last run"):**

```bash
bun scripts/phpunit -s failed --format terminal --verbose
```

**Otherwise:** Parse the provided test output directly.

### Step 2: Extract Unique Test Classes

From the test output, extract unique test class names. Look for patterns like:

- `Tests\Http\Controllers\Api\Admin\SomeControllerTest`
- `Tests\Services\SomeServiceTest`
- `FAILED Tests\...\ClassName::methodName`

Group failures by CLASS, not by method. Each class should appear only once.

### Step 3: Read Testing Documentation

Before spawning agents, read the testing conventions:

```
.claude/docs/testing.md
```

The spawned agents should read the file too.

### Step 4: Spawn Parallel Fix Agents

For each unique failing test CLASS, spawn ONE agent using Task tool:

```
Task: Fix failing tests in {ClassName}

subagent_type: general-purpose

Prompt:
"You are fixing failing PHPUnit tests for the Reservine Laravel application.

**Test Class**: {full.class.name}
**Test File**: tests/{path/to/TestClass}.php

**Error Messages**:
{paste all error messages for this class}

**Instructions**:
1. First, read `.claude/docs/testing.md` to understand testing patterns
2. Read the test file to understand what's being tested
3. Read related source files (Controllers, Services, Models) as needed
4. Analyze the failure cause from error messages
5. Fix the issue - either in:
   - The SOURCE code (if the test is correct but code is broken)
   - The TEST file (if the test has incorrect expectations)
6. Do NOT run tests yourself - the main agent will run tests after all fixes

**Critical Rules**:
- Use `getTenant()` - NEVER create new Tenant
- No mocks unless absolutely necessary
- Follow existing code patterns in sibling files
- Use constructor DI with `private readonly`
- PHPStan level 7 compliance required

When done, summarize:
- What was broken (test or source)
- What you fixed
- Files modified
"
```

**Important**: Launch ALL agents in parallel (one Task call per class).

### Step 5: Run Tests After Agents Complete

Once all agents finish, run the combined test filter:

```bash
bun scripts/phpunit --filter="(FirstClassTest|SecondClassTest|ThirdClassTest)" --format terminal --verbose
```

- or maybe --format json which you can play with a bit better with jq maybe?
- In all cases, save the output to some temporary file which you read in full without doing "head" or "tail"

Use the short class names joined with `|` in the filter pattern.

### Step 6: Iterate If Failures Remain

If tests still fail after first round:

1. Parse new failures
2. Extract still-failing classes
3. Spawn new agents ONLY for those classes
4. Run tests again

**Maximum iterations**: 5 rounds. After 5 rounds, report unfixable tests.

### Step 7: Write Fix Report

Create report at: `.claude/docs/tests/fixes/{YYYY-MM-DD}-{first-class}-to-{last-class}.md`

**Report Format**:

```markdown
# Test Fix Report - {date}

## Summary

- **Total Classes Fixed**: X
- **Total Iterations**: Y
- **Status**: All passing / Some unfixable

## Unfixable Tests (if any)

| Test Class | Reason                   |
| ---------- | ------------------------ |
| ClassName  | Why it couldn't be fixed |

## Fixed Tests

### {ClassName1}

- **Issue**: Brief description
- **Fix**: What was changed
- **Files Modified**: list of files

### {ClassName2}

...
```

## Key Rules

1. **One agent per CLASS** - not per test method
2. **Agents do NOT run tests** - only the main agent runs tests
3. **Maximum 5 iterations** before giving up
4. **Parallel execution** - spawn all agents simultaneously
5. **Read testing.md first** - agents must follow project patterns
6. **Fix source OR test** - analyze which is actually broken

## Example Flow

```
Input: "last-failed"

1. Run: bun scripts/phpunit -s failed --format terminal --verbose
2. Extract: VoucherTemplatesControllerTest, ReservationServiceTest
3. Read: .claude/docs/testing.md
4. Spawn 2 parallel agents (one per class)
5. Wait for agents to complete
6. Run: bun scripts/phpunit --filter="(VoucherTemplatesControllerTest|ReservationServiceTest)"
7. If still failing: iterate (max 5 times)
8. Write report to .claude/docs/tests/fixes/2025-01-15-VoucherTemplatesControllerTest-to-ReservationServiceTest.md
```

## Error Message Patterns to Extract

When parsing test output, look for:

- `FAILED Tests\...\ClassName::methodName`
- `1) Tests\...\ClassName::methodName`
- `Error: ...` (include full error message)
- `Failed asserting that ...`
- Stack traces with file:line references

Include ALL error context when passing to agents - they need full information to diagnose issues.
