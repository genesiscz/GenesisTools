---
description: Run Laravel tests in a forked sub-agent context
context: fork
---

# Run Tests Isolated

Execute Laravel test suite in an isolated sub-agent context. Test output stays separate, main session stays clean.

## Usage

```bash
/run-tests-isolated [path] [--filter=name] [--compact]
```

## Examples

```bash
# Run all tests
/run-tests-isolated

# Run specific test file
/run-tests-isolated tests/Services/ReservationServiceTest.php

# Run with filter and compact output
/run-tests-isolated --filter=testReservationCreation --compact

# Run tests in directory
/run-tests-isolated tests/Services --compact
```

## Real-World Scenarios

### Scenario 1: Parallel Testing
```bash
# In forked context (isolated execution)
/run-tests-isolated tests/Services

# Meanwhile in main session, you continue coding
# Edit files, write new code, etc.
# Results return automatically when ready
```

### Scenario 2: Multiple Test Runs
Run different test suites simultaneously:

Terminal 1 (main session):
```bash
# Continue working on code
[editing feature]
```

Terminal 2 (forked context):
```bash
/run-tests-isolated tests/Services --compact
# Runs in isolation - output won't interfere
```

Terminal 3 (forked context):
```bash
/run-tests-isolated tests/Http/Controllers --compact
# Another isolated test run
```

## Why Fork Context is Perfect for Testing

✅ **No Output Pollution** - Massive test output stays in forked context
✅ **Main Session Stays Clean** - You keep typing, coding, creating
✅ **Parallel Testing** - Run multiple test suites at once
✅ **Responsive UX** - Claude Code doesn't stall on long test runs
✅ **Easy Retry** - Rerun tests without repeating whole command
✅ **Context Isolation** - Test database operations don't affect main conversation

## Expected Output

```
## Test Results (forked context)

✅ 42 passed
❌ 3 failed
⏭️  2 skipped

### Failed Tests
1. ReservationServiceTest::testCancellationWithRefund
   - AssertionError: Expected refund amount, got null

2. StripeWebhookTest::testChargeRefunded
   - Error: Mock payment intent not found

### Summary
Fix the money handling in ReservationService::refund()
```

## Implementation Benefits

- **Faster iteration** - Don't wait for tests to finish
- **Multi-tasking** - Work on fixes while tests run
- **Better feedback** - Focused reports, not verbose output
- **Less context waste** - No 1000-line test output in conversation
