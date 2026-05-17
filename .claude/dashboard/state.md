# State Management

> TanStack Store, Query, and local hooks

## State Layers

| Layer | Tool | Purpose |
|-------|------|---------|
| Server state | TanStack Query | API data, caching |
| Client state | TanStack Store | Global UI state |
| Local state | useState | Component state |
| Form state | TanStack Form | Form handling |
| Persisted | localStorage | Settings, preferences |

## TanStack Store

Simple reactive store for client state:

```tsx
// src/lib/demo-store.ts
import { Store, Derived } from '@tanstack/store'

export const store = new Store({
  firstName: 'Jane',
  lastName: 'Smith',
})

// Derived values
export const fullName = new Derived({
  fn: () => `${store.state.firstName} ${store.state.lastName}`,
  deps: [store],
})
fullName.mount()

// In components
import { useStore } from '@tanstack/react-store'

function Component() {
  const firstName = useStore(store, (s) => s.firstName)
  const full = useStore(fullName)

  store.setState((s) => ({ ...s, firstName: 'John' }))
}
```

## TanStack Query

Server state management with caching:

```tsx
// Setup in src/integrations/tanstack-query/root-provider.tsx
import { QueryClient } from '@tanstack/react-query'
import superjson from 'superjson'

const queryClient = new QueryClient({
  defaultOptions: {
    dehydrate: { serializeData: superjson.serialize },
    hydrate: { deserializeData: superjson.deserialize },
  },
})

// Usage
import { useQuery, useMutation } from '@tanstack/react-query'

const { data, isLoading } = useQuery({
  queryKey: ['todos'],
  queryFn: () => fetch('/api/todos').then(r => r.json()),
})
```

## tRPC Integration

Type-safe API with Query:

```tsx
// Router: src/integrations/trpc/router.ts
import { createTRPCRouter, publicProcedure } from './init'

export const trpcRouter = createTRPCRouter({
  todos: {
    list: publicProcedure.query(() => todos),
    add: publicProcedure
      .input(z.object({ name: z.string() }))
      .mutation(({ input }) => {
        todos.push({ id: todos.length + 1, name: input.name })
        return todos[todos.length - 1]
      }),
  },
})

// Usage in components
import { useTRPC } from '@/integrations/trpc/react'

function Component() {
  const trpc = useTRPC()
  const { data } = trpc.todos.list.useQuery()
  const addMutation = trpc.todos.add.useMutation()
}
```

## Settings Hook

Custom hook with localStorage persistence:

```tsx
// src/hooks/useSettings.ts
import { useSettings } from '@/hooks/useSettings'

function Component() {
  const { settings, updateSetting, updateSettings } = useSettings()

  // Read
  console.log(settings.theme)  // 'dark' | 'light' | 'system'

  // Update single
  updateSetting('scanLinesEffect', false)

  // Update multiple
  updateSettings({ theme: 'dark', soundEffects: true })
}

// Available settings
interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  scanLinesEffect: boolean
  gridBackground: boolean
  reducedMotion: boolean
  pushNotifications: boolean
  soundEffects: boolean
  timerCompleteAlert: boolean
  cloudSync: boolean
  localStorage: boolean
  analytics: boolean
  language: string
  timeFormat: '12h' | '24h'
}
```

## WorkOS Auth State

```tsx
import { useAuth } from '@workos/authkit-tanstack-react-start/client'

function Component() {
  const { user, isLoading, signOut } = useAuth()

  if (isLoading) return <Loader />
  if (!user) return <Navigate to="/auth/signin" />

  return <div>Hello, {user.firstName}</div>
}
```

## Timer Feature State

Example of feature-specific state management:

```tsx
// src/routes/timer/hooks/useTimerStore.ts
// Manages collection of timers with localStorage + cross-tab sync

// src/routes/timer/hooks/useTimer.ts
// Single timer state with start/stop/reset

// src/routes/timer/hooks/useTimerEngine.ts
// Tick loop for running timers

// src/routes/timer/hooks/useActivityLog.ts
// Activity history tracking
```

## PowerSync (Offline-First)

For offline-capable data sync:

```tsx
// src/db/powersync-connector.ts
import { DashboardConnector } from '@/db/powersync-connector'

// Connector handles:
// - fetchCredentials: Exchange WorkOS session for PowerSync JWT
// - uploadData: Sync local changes to backend
```

## React Compiler Note

Do NOT use `useCallback` or `useMemo` - the React Compiler handles memoization automatically via `babel-plugin-react-compiler`.
