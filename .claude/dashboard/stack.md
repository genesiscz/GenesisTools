# Technology Stack

> Full-stack React with TanStack ecosystem

## Core Dependencies

### Framework & Build

| Package | Version | Purpose |
|---------|---------|---------|
| `@tanstack/react-start` | ^1.132.0 | Full-stack React framework |
| `@tanstack/react-router` | ^1.132.0 | File-based routing |
| `vite` | ^7.1.7 | Build tool |
| `react` | ^19.2.0 | UI library |
| `turbo` | ^2.7.3 | Monorepo build system |
| `bun` | 1.3.5 | Package manager (via packageManager field) |

### State & Data

| Package | Purpose |
|---------|---------|
| `@tanstack/react-query` | Server state, caching |
| `@tanstack/react-store` | Client state management |
| `@tanstack/react-db` | DB collections |
| `@trpc/client` + `@trpc/server` | Type-safe API layer |
| `@powersync/web` | Offline-first SQLite sync |
| `convex` | Demo real-time database |

### Auth

| Package | Purpose |
|---------|---------|
| `@workos-inc/node` | WorkOS server SDK |
| `@workos/authkit-tanstack-react-start` | TanStack Start auth integration |
| `iron-session` | Session encryption |

### AI

| Package | Purpose |
|---------|---------|
| `@tanstack/ai` | AI abstractions |
| `@tanstack/ai-anthropic` | Claude provider |
| `@tanstack/ai-openai` | OpenAI provider |
| `@tanstack/ai-gemini` | Gemini provider |
| `@tanstack/ai-ollama` | Ollama provider |
| `@tanstack/ai-react` | React hooks for AI |

### UI & Styling

| Package | Purpose |
|---------|---------|
| `tailwindcss` | ^4.0.6 | Utility CSS |
| `@tailwindcss/vite` | Vite plugin |
| `class-variance-authority` | Variant styling |
| `clsx`, `tailwind-merge` | Class utilities |
| `@radix-ui/*` | Headless UI primitives |
| `lucide-react` | Icons |
| `sonner` | Toast notifications |

### Forms & Validation

| Package | Purpose |
|---------|---------|
| `@tanstack/react-form` | Form state |
| `zod` | ^4.1.11 | Schema validation |
| `@t3-oss/env-core` | Environment validation |

### Dev Tools

| Package | Purpose |
|---------|---------|
| `@tanstack/react-devtools` | Unified devtools panel |
| `@tanstack/react-query-devtools` | Query inspector |
| `@tanstack/react-router-devtools` | Router inspector |
| `@tanstack/react-ai-devtools` | AI debugging |
| `@biomejs/biome` | Linting/formatting |
| `vitest` | Testing |
| `babel-plugin-react-compiler` | Auto memoization |

## Vite Plugins

From `apps/web/vite.config.ts`:

```ts
plugins: [
  devtools(),           // TanStack devtools
  nitro(),              // Nitro server integration
  neon,                 // Custom Neon DB plugin
  viteTsConfigPaths(),  // Path aliases
  tailwindcss(),        // Tailwind v4
  tanstackStart(),      // TanStack Start SSR
  viteReact({           // React with compiler
    babel: { plugins: ['babel-plugin-react-compiler'] }
  }),
]
```

## React Compiler Note

The project uses React Compiler (babel-plugin-react-compiler). **Do NOT use `useCallback` or `useMemo`** - the compiler handles memoization automatically.
