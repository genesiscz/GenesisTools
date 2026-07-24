#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun scripts/test.ts src/utils/log-session/
bun scripts/test.ts src/task/lib/
bun scripts/test.ts src/task/tests/task.integration.test.ts
bun scripts/test.ts src/task/tests/dashboard.integration.test.ts
echo "✓ task tool verification passed"
