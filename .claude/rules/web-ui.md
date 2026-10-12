---
paths:
  - "**/*.tsx"
  - "src/*/ui/**"
  - "src/dashboard/**"
  - "src/dev-dashboard/**"
  - "src/utils/ui/**"
---

# Web UI

Loaded by Claude Code when you read, write or edit a `.tsx` file or a file in a web UI folder.

## Building or Restyling Web UI

**Before writing or restyling ANY web UI** (`src/<tool>/ui`, `src/dashboard`, `src/dev-dashboard/ui`), read `docs/design-system.md`. It is the single shared-UI contract: theme tokens + `@ui/components/*` primitives + `wow-components.css` looks. Hard rules: no raw `zinc-*`/`white/NN` palette in app code (use theme tokens), never override a `<Card>`'s surface, pick a rich Button/Card variant on purpose, wrap routes in the shared shell/auth-layout. This doc exists because clarity & shops drifted "flat" by ignoring it while the dashboard didn't — don't repeat that. For per-dashboard design lineage (all 8 dashboards categorized into design families; why youtube/dev-dashboard diverge) see `docs/design-system-dashboards.md`; for the canonical ports/launch registry + conflict detection see `src/utils/ui/dashboards.ts`.
