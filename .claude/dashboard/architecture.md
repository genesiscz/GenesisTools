# Dashboard Architecture

> Turborepo monorepo with TanStack Start web app

## Find It Fast

| Looking for... | Go to |
|----------------|-------|
| Web app | `src/dashboard/apps/web/` |
| Server (Nitro) | `src/dashboard/apps/server/` |
| Docs (unused) | `src/dashboard/apps/docs/` |
| Shared types/utils | `src/dashboard/packages/shared/` |
| UI components (pkg) | `src/dashboard/packages/ui/` |
| Root config | `src/dashboard/package.json`, `turbo.json` |

## Monorepo Structure

```
src/dashboard/
├── apps/
│   ├── web/          # TanStack Start app (main)
│   └── server/       # Nitro server (API backend)
├── packages/
│   ├── shared/       # @dashboard/shared - types, utils, constants
│   ├── ui/           # @dashboard/ui - turborepo example components
│   ├── eslint-config/
│   ├── typescript-config/
│   └── tailwind-config/
└── turbo.json        # Turborepo task config
```

## Stack Overview

| Layer | Technology |
|-------|------------|
| Framework | TanStack Start (React 19, Vite, SSR) |
| Router | TanStack Router (file-based) |
| State | TanStack Store, React Query |
| Auth | WorkOS AuthKit |
| Styling | Tailwind CSS v4, shadcn/ui |
| DB Sync | PowerSync (SQLite, offline-first) |
| API | tRPC, Nitro server |
| Build | Turborepo, Vite, Bun |

## Web App Entry Points

| File | Purpose |
|------|---------|
| `vite.config.ts` | Vite + plugins config |
| `src/start.ts` | TanStack Start instance + middleware |
| `src/router.tsx` | Router creation + SSR query setup |
| `src/routes/__root.tsx` | Root layout, providers, devtools |
| `src/routes/index.tsx` | Home page (auth redirect) |

## Key Integrations

| Integration | Location | Purpose |
|-------------|----------|---------|
| WorkOS | `src/integrations/workos/` | Auth provider |
| TanStack Query | `src/integrations/tanstack-query/` | Data fetching |
| tRPC | `src/integrations/trpc/` | Type-safe API |
| Convex | `src/integrations/convex/`, `convex/` | Demo real-time DB |

## Build Commands

```bash
bun run dev    # Start web + server in dev mode
bun run build  # Build all apps
bun run lint   # Lint all packages
```
