---
description: Analyze failing tests in an isolated context
context: fork
---

# Analyze Test Failures

Run tests and diagnose failures in an isolated sub-agent context. This prevents heavy test output from cluttering your main session.

## Usage

```bash
/analyze-test-failures [--file=path] [--filter=testname]
```

## Examples

```bash
# Analyze all failing tests
/analyze-test-failures

# Analyze specific test file
/analyze-test-failures --file=tests/Services/ReservationServiceTest.php

# Analyze specific test method
/analyze-test-failures --filter=testReservationCreation
```

## What This Does

1. **Runs tests** in a forked context (isolated execution)
2. **Parses failures** without polluting main session
3. **Generates report** with root causes and fixes
4. **Returns to main session** with clean summary

## Why Fork Context?

- Test output can be **massive** (phpunit verbose output)
- Analysis happens **independently** without affecting your main conversation
- Main session stays **clean** and focused
- Easy to **retry** or run with different filters
