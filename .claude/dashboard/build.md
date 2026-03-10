# Build System

> Turborepo + Vite + Bun

## Commands

From `src/dashboard/`:

```bash
bun run dev     # Start web + server in dev mode
bun run build   # Build all apps
bun run lint    # Lint all packages
bun run check-types  # TypeScript checks
bun run format  # Prettier format
```

## Turborepo Config

From `turbo.json`:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": { "dependsOn": ["^lint"] },
    "check-types": { "dependsOn": ["^check-types"] }
  }
}
```

## Package Scripts

### Root (`package.json`)

```json
{
  "scripts": {
    "dev": "turbo run dev --filter=@dashboard/web --filter=@dashboard/server",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "check-types": "turbo run check-types"
  }
}
```

### Web App (`apps/web/package.json`)

```json
{
  "scripts": {
    "dev": "vite dev --port 3000",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "biome lint",
    "check": "biome check"
  }
}
```

## Vite Configuration

From `apps/web/vite.config.ts`:

```ts
export default defineConfig({
  plugins: [
    devtools(),           // TanStack devtools
    nitro(),              // Nitro server
    neon,                 // Custom DB plugin
    viteTsConfigPaths(),  // Path aliases
    tailwindcss(),        // Tailwind v4
    tanstackStart(),      // TanStack Start SSR
    viteReact({
      babel: { plugins: ['babel-plugin-react-compiler'] }
    }),
  ],
  resolve: {
    alias: {
      '@dashboard/shared': '../../packages/shared/src/index.ts',
      '@dashboard/ui': '../../packages/ui/src/index.ts',
    },
  },
  worker: { format: 'es' },  // For PowerSync workers
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite'],  // PowerSync dep
  },
})
```

## Workspaces

Configured in root `package.json`:

```json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

## Package Structure

| Package | Name | Exports |
|---------|------|---------|
| `apps/web` | `@dashboard/web` | - |
| `apps/server` | `@dashboard/server` | - |
| `packages/shared` | `@dashboard/shared` | types, utils, constants |
| `packages/ui` | `@dashboard/ui` | UI components |

## Build Outputs

- `apps/web/.output/` - TanStack Start production build
- `apps/server/dist/` - Nitro server build
- `packages/ui/dist/` - UI package build

## Environment Files

| File | Purpose |
|------|---------|
| `.env` | Shared environment |
| `.env.local` | Local overrides (gitignored) |
| `.env.example` | Template |

## Dev Mode

```bash
bun run dev
```

Starts:
- Web app on `http://localhost:3000`
- Nitro server (integrated)
- HMR enabled
- DevTools available

## Production Build

```bash
bun run build
bun run preview  # Preview production build
```
