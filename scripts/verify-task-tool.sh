#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test src/utils/log-session/
bun test src/task/lib/
bun test src/task/tests/task.integration.test.ts
bun test src/task/tests/dashboard.integration.test.ts
echo "✓ task tool verification passed"
