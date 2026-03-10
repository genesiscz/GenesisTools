# Code Organization

> Web app directory structure and file patterns

## apps/web/src/ Structure

```
src/
├── routes/              # File-based routes (TanStack Router)
│   ├── __root.tsx       # Root layout + providers
│   ├── index.tsx        # Home (auth redirect)
│   ├── auth/            # Auth pages (signin, signup, etc.)
│   ├── dashboard/       # Dashboard pages
│   ├── timer/           # Timer feature (full module)
│   ├── demo/            # Demo/example pages
│   └── profile.tsx, settings.tsx
├── components/
│   ├── ui/              # shadcn/ui components
│   ├── dashboard/       # Dashboard layout components
│   └── auth/            # Auth UI components
├── hooks/               # Global React hooks
├── integrations/        # Third-party integrations
│   ├── workos/          # Auth provider
│   ├── tanstack-query/  # Query provider + devtools
│   ├── trpc/            # tRPC client + router
│   └── convex/          # Convex provider (demo)
├── lib/                 # Utilities and helpers
├── data/                # Demo/static data
├── db/                  # Database connectors
├── db-collections/      # TanStack DB collections
├── styles.css           # Global styles + Tailwind
├── router.tsx           # Router creation
├── start.ts             # TanStack Start instance
└── env.ts               # Environment validation
```

## Route File Patterns

| Pattern | Purpose |
|---------|---------|
| `__root.tsx` | Root layout (providers, devtools) |
| `index.tsx` | Index route for directory |
| `$param.tsx` | Dynamic route segment |
| `api.*.ts` | API routes (server functions) |
| `*.tsx` | Page components |

## Feature Module Pattern

Complex features use a module structure (see `/timer/`):

```
routes/timer/
├── index.tsx            # Main page component
├── components/          # Feature-specific components
│   ├── index.ts         # Barrel export
│   ├── TimerCard.tsx
│   └── ...
├── hooks/               # Feature-specific hooks
│   ├── index.ts         # Barrel export
│   ├── useTimer.ts
│   ├── useTimerStore.ts
│   └── ...
└── lib/
    └── storage/         # Storage adapters
```

## packages/shared/ Structure

```
packages/shared/src/
├── index.ts             # Barrel export
├── types/
│   ├── index.ts
│   ├── timer.ts         # Timer types + Zod schemas
│   └── activity-log.ts
├── utils/
│   ├── index.ts
│   └── time.ts
└── constants/
    └── index.ts
```

## Import Aliases

Configured in `tsconfig.json`:

| Alias | Path |
|-------|------|
| `@/*` | `./src/*` |
| `@dashboard/shared` | `../../packages/shared/src/index.ts` |
| `@dashboard/ui` | `../../packages/ui/src/index.ts` |

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/__root.tsx` | Root layout, providers, devtools setup |
| `src/start.ts` | TanStack Start with WorkOS middleware |
| `src/router.tsx` | Router creation with SSR Query |
| `src/styles.css` | CSS variables, Tailwind config, animations |
| `src/lib/auth-actions.ts` | Server functions for auth |
| `src/lib/auth-server.ts` | WorkOS server utilities |
