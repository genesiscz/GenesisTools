# Dashboard Documentation

> Navigation index for the dashboard codebase (`src/dashboard/`)

## Quick Start

```bash
cd src/dashboard
bun install
bun run dev  # http://localhost:3000
```

## Documentation Index

| Doc | Purpose |
|-----|---------|
| [architecture.md](./architecture.md) | Monorepo structure, stack overview |
| [stack.md](./stack.md) | All dependencies and their purposes |
| [structure.md](./structure.md) | Directory layout, file patterns |
| [components.md](./components.md) | UI components, shadcn/ui, theming |
| [routing.md](./routing.md) | TanStack Router, file-based routes |
| [state.md](./state.md) | State management patterns |
| [build.md](./build.md) | Build commands, Turborepo, Vite |
| [patterns.md](./patterns.md) | Code patterns and conventions |

## Find It Fast

| Looking for... | Go to |
|----------------|-------|
| Main web app | `src/dashboard/apps/web/` |
| Routes | `src/dashboard/apps/web/src/routes/` |
| UI components | `src/dashboard/apps/web/src/components/ui/` |
| Dashboard layout | `src/dashboard/apps/web/src/components/dashboard/` |
| Auth logic | `src/dashboard/apps/web/src/lib/auth-*.ts` |
| Timer feature | `src/dashboard/apps/web/src/routes/timer/` |
| Shared types | `src/dashboard/packages/shared/src/types/` |
| Root config | `src/dashboard/package.json`, `turbo.json` |
| Vite config | `src/dashboard/apps/web/vite.config.ts` |
| Styles | `src/dashboard/apps/web/src/styles.css` |

## Key Facts

- **Framework**: TanStack Start (React 19 + Vite + SSR)
- **Auth**: WorkOS AuthKit
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **State**: TanStack Query + Store
- **Build**: Turborepo + Bun
- **React Compiler**: Do NOT use `useCallback`/`useMemo`

## Context Triggers

<context_trigger keywords="dashboard,tanstack,start,web,routes">
**Load:** .claude/dashboard/architecture.md, .claude/dashboard/structure.md
**Files:** src/dashboard/apps/web/src/routes/, src/dashboard/apps/web/vite.config.ts
**Quick:** TanStack Start web app in Turborepo monorepo. File-based routing.
</context_trigger>

<context_trigger keywords="component,ui,shadcn,button,card,sidebar">
**Load:** .claude/dashboard/components.md
**Files:** src/dashboard/apps/web/src/components/ui/, src/dashboard/apps/web/src/components/dashboard/
**Quick:** shadcn/ui components with cyberpunk theme. Use cn() for class merging.
</context_trigger>

<context_trigger keywords="auth,login,signin,signup,workos,session">
**Load:** .claude/dashboard/patterns.md
**Files:** src/dashboard/apps/web/src/lib/auth-actions.ts, src/dashboard/apps/web/src/routes/auth/
**Quick:** WorkOS AuthKit. useAuth() for client, createServerFn for server actions.
</context_trigger>

<context_trigger keywords="route,router,navigation,page">
**Load:** .claude/dashboard/routing.md
**Files:** src/dashboard/apps/web/src/routes/, src/dashboard/apps/web/src/router.tsx
**Quick:** TanStack Router file-based. createFileRoute(), Link, useNavigate.
</context_trigger>

<context_trigger keywords="state,store,query,trpc,settings">
**Load:** .claude/dashboard/state.md
**Files:** src/dashboard/apps/web/src/hooks/, src/dashboard/apps/web/src/integrations/
**Quick:** TanStack Query + Store. tRPC for type-safe API. useSettings() for prefs.
</context_trigger>

<context_trigger keywords="timer,stopwatch,countdown,pomodoro">
**Load:** .claude/dashboard/patterns.md
**Files:** src/dashboard/apps/web/src/routes/timer/
**Quick:** Timer feature module with hooks, components, storage adapters.
</context_trigger>

<context_trigger keywords="build,turbo,vite,dev,bun">
**Load:** .claude/dashboard/build.md
**Files:** src/dashboard/package.json, src/dashboard/turbo.json, src/dashboard/apps/web/vite.config.ts
**Quick:** bun run dev starts web+server. Turborepo for monorepo builds.
</context_trigger>
