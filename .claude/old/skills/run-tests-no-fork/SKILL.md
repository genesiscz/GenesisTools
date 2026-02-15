---
description: Run Laravel tests WITHOUT fork context (for comparison)
---

# Run Tests (No Fork)

Execute Laravel test suite in the MAIN session context (no forking).

## Usage

```bash
/run-tests-no-fork [path] [--filter=name] [--compact]
```

This version runs tests DIRECTLY in your main session without isolation.
