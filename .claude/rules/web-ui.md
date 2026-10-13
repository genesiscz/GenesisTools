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

## Dashboard rules

- **Sentence case everywhere**: labels, headings, badges, tabs, table headers, nav items and buttons. Never the `uppercase` class, `text-transform: uppercase` or a literal ALL CAPS word (acronyms such as URL, CPU and API stay). Before you ship, `rg -n '\buppercase\b'` over the dashboard sources must find only `first-letter:uppercase`.
- **Ask which theme** (`cyberpunk`, `gold-bento`, `native`) and which style choices before you create a dashboard or change its look. Do not default to one.
- **Generic UI elements are shadcn components** in `src/utils/ui/components/`. Before custom markup for an alert, dialog, popover, tooltip or form, check whether shadcn has the component and install it there.
- **After agent-driven edits to a dashboard, sweep it in a real browser**: open every route and feature the edits touched, fix what broke, sweep again. A passing typecheck and build prove nothing about behaviour.
