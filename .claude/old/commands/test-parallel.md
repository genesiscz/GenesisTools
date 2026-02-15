# Run Tests in Background

Launch a Haiku agent to run tests in the background while you continue fixing other code.

## CRITICAL WORKFLOW RULE

**After launching the test agent, you MUST IMMEDIATELY continue working on other tasks!**

Do NOT wait for the agent to complete. The whole point is:
1. Launch agent in background → 2. Continue fixing code → 3. Check results later

This maximizes productivity by eliminating wait time.

## Usage

```
/test-parallel tests/Services/ReservationServiceTest.php tests/Http/Controllers/ReservationsControllerTest.php
/test-parallel tests/Services/*.php
/test-parallel tests/Http/Controllers/Api/*.php
```

## Input: $ARGUMENTS

Test file paths (space-separated). Supports glob patterns matching test files.

## Process

### Step 1: Validate Test Files

Parse the provided test file paths and validate they exist. If glob patterns are provided, expand them.

### Step 2: Read Testing Documentation

Before spawning the agent, read the testing conventions:

```
.claude/docs/testing.md
```

The spawned agent will also read this file.

### Step 3: Launch Test Agent

Spawn ONE Haiku agent in background using Task tool to run all provided test files:

```
Task: Run tests in {file1}, {file2}, ... (count of files)

subagent_type: general-purpose
model: haiku
run_in_background: true

Prompt:
"You are running PHPUnit tests for the Reservine Laravel application.

**Test Files**:
{list of test file paths}

**Instructions**:
1. First, read `.claude/docs/testing.md` to understand testing patterns
2. Run all provided tests using:
   timeout 120 ./vendor/bin/sail artisan test {file1} {file2} ... --compact 2>&1
3. Report ONLY:
   - Did ALL tests pass? (YES/NO with count)
   - If NO: List each failed test with its class::method name + essential error (1-2 lines max)
4. Do NOT include:
   - Full stack traces
   - Passing test names
   - Verbose output
   - Timeslot generation logs
   - Any other non-essential information

**Critical Rules**:
- Use `getTenant()` - NEVER create new Tenant
- No mocks unless absolutely necessary
- Follow existing code patterns
- Use constructor DI with `private readonly`
- PHPStan level 7 compliance required
"
```

**Important**: This launches ONE agent that can run MULTIPLE files at once. Never spawn multiple test agents in parallel.

### Step 4: IMMEDIATELY Continue Working (DO NOT WAIT!)

**THIS IS CRITICAL**: After launching the agent, DO NOT call TaskOutput with block=true. Instead:

1. **Immediately** start fixing other issues (other test files, source code, etc.)
2. Use `TaskOutput: { block: false }` only for quick status checks
3. Only use `block: true` when you have absolutely nothing else to do

While the agent runs:
- Fix other source files
- Read code to understand issues
- Make edits to related files
- Work on completely different tasks
- Do NOT launch another test agent until this one completes

### Step 5: Monitor Agent Status (Non-Blocking)

Periodically check agent progress without blocking:

```
TaskOutput: { block: false }
```

### Step 6: Process Results When Complete

When agent completes:
1. Review pass/fail status
2. If any tests failed:
   - Identify which tests failed
   - Fix the source code or test as appropriate
   - Launch a new test agent to verify fixes (only after previous agent completes)
3. If all passed:
   - Mark task as completed
   - Run final validation with `sail a test` locally if needed

## Key Rules

1. **ONE test agent at a time** - Never spawn multiple test agents in parallel (they share database)
2. **Multiple files in one agent** - One agent CAN run many test files at once
3. **Compact output** - Use `--compact` flag to reduce noise
4. **Timeout protection** - Commands default to 120 second timeout
5. **Essential info only** - Agent reports pass/fail + error summaries only
6. **Sequential launching** - Wait for current agent to complete before launching next batch
7. **Read testing.md first** - Agent must follow project testing patterns

## Common Test Patterns

```bash
# Single test file
/test-parallel tests/Services/ReservationServiceTest.php

# Multiple specific files
/test-parallel tests/Services/ReservationServiceTest.php tests/Services/InvoiceServiceTest.php

# All service tests
/test-parallel tests/Services/*.php

# All controller tests
/test-parallel tests/Http/Controllers/Api/*.php

# With specific test method filter (optional - add to agent prompt)
# timeout 120 ./vendor/bin/sail artisan test tests/File.php --filter=testMethodName --compact
```

## Workflow Integration

After running tests:

1. If **all pass**: Task is complete
2. If **some fail**: Fix issues and run a new `/test-parallel` with only the failing test files
3. **Never re-run passing tests** - focus only on failing ones to save time
4. **Multiple iterations OK** - Run agents sequentially until all tests pass

## Error Handling

If agent hangs or times out:
- Agent timeout is 120 seconds per batch
- If stuck, manually check test status with `sail a test <file> --compact`
- Consider breaking into smaller test batches

## Integration with Todo List

Update TodoWrite when:
- Starting a test agent (mark as in_progress)
- Agent completes successfully (mark as completed)
- Agent reports failures (keep in_progress, add fix tasks)

## Example Workflow

```
User: /test-parallel tests/Services/ReservationServiceTest.php tests/Http/Controllers/ReservationsControllerTest.php

Agent:
1. Validates files exist
2. Reads .claude/docs/testing.md
3. Spawns Haiku agent with both files
4. User continues fixing other code while agent runs
5. Agent completes: "2 files: 45 passed, 0 failed ✓"
6. Task complete

OR if failures:

Agent reports: "FAILED ReservationServiceTest::testCreateReservation - Undefined method getTenant()"

User:
1. Fixes the test
2. Runs: /test-parallel tests/Services/ReservationServiceTest.php
3. Agent completes: "1 file: 20 passed, 0 failed ✓"
4. Task complete
```
