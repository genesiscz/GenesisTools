---
description: Deep codebase analysis without cluttering main session
context: fork
---

# Codebase Analysis

Perform deep codebase exploration and analysis in an isolated sub-agent context. Heavy Grep/Glob operations stay separate from your main work.

## Usage

```bash
/codebase-analysis [--type=pattern] [--output=summary|detailed]
```

## Examples

```bash
# Find all money-related operations
/codebase-analysis --type=money

# Analyze permission checks across codebase
/codebase-analysis --type=permissions --output=detailed

# Find N+1 query issues
/codebase-analysis --type=queries

# Analyze DTOs and their usage
/codebase-analysis --type=dtos
```

## What This Does

1. **Launches isolated agent** to search codebase
2. **Performs extensive Grep/Glob** without blocking main session
3. **Analyzes patterns** independently
4. **Returns structured report** to main session
5. **You continue working** while analysis runs

## Why Fork Context?

- **Intensive searching** (ripgrep, glob patterns) runs in parallel
- Main session **remains responsive** for other work
- Can run **multiple analyses** simultaneously
- Clean **separation of concerns**
- No context pollution from intermediate search steps

## Example Output

```
## Permission Checks Found (12 files)

### app/Http/Controllers/ReservationController.php
- Line 45: $this->permissions->needsViewReservation()
- Line 89: $this->permissions->needsEditReservation()

### app/Services/ReservationService.php
- Line 234: Missing permission check

## Recommendations
1. Add permission check in ReservationService::updateStatus
2. Audit other service methods for missing checks
```
