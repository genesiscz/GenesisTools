---
description: Run PHPStan type checking in isolated context
context: fork
---

# PHPStan Check

Run comprehensive PHPStan type checking in a forked sub-agent context. Heavy analysis stays separate from main work.

## Usage

```bash
/phpstan-check [--files=pattern] [--level=7] [--fix=true]
```

## Examples

```bash
# Check all files
/phpstan-check

# Check specific directory
/phpstan-check --files=app/Services

# Check modified files and suggest fixes
/phpstan-check --files=app/Data --fix=true

# Check specific file
/phpstan-check --files=app/Services/ReservationService.php
```

## What This Does

1. **Spawns isolated agent** with PHPStan analyzer
2. **Scans files** for type errors (level 7)
3. **Analyzes results** independently
4. **Generates report** with:
   - Error breakdown by file
   - Severity levels
   - Suggested fixes
   - Type annotation improvements
5. **Returns summary** to main session

## Example Report

```
## PHPStan Results (app/Services)

### ❌ 5 Errors Found

ReservationService.php:
  - Line 234: Parameter $status expects ReservationStatus, string given
  - Line 456: Mixed type not covered - expecting int|null

BookingService.php:
  - Line 123: Call to undefined method on Collection

MoneyService.php:
  - ✅ Clean

## Quick Fixes Suggested
1. Add @param type hint to ReservationService::setStatus()
2. Use proper enum instead of string
3. Add Collection generic @template
```

## Why Fork Context?

- **Analysis is intensive** (full codebase scan)
- Main session **remains responsive**
- Can **run while editing** other files
- **No timeout issues** from long-running scans
- Easy to **batch check** multiple components
- Results **don't affect** main conversation context

## Integration with Your Workflow

Perfect for:
- Pre-commit checks
- Feature branch validation
- Refactoring verification
- Type safety audits
