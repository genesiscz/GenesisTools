# Key Patterns

> Common code patterns used throughout the dashboard

## Server Functions

TanStack Start server functions for server-side logic:

```tsx
// src/lib/auth-actions.ts
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const signInFn = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const parsed = signInSchema.safeParse(data)
    if (!parsed.success) {
      return { code: 'validation_error', message: parsed.error.issues[0]?.message }
    }
    return parsed.data
  })
  .handler(async ({ data }) => {
    // Server-side logic
    const result = await workos.userManagement.authenticateWithPassword({...})
    return { success: true, session: encryptSession(result) }
  })

// Usage in component
const result = await signInFn({ data: { email, password } })
```

## Feature Module Pattern

Organize complex features as self-contained modules:

```
routes/[feature]/
├── index.tsx           # Main route/page
├── components/
│   ├── index.ts        # Barrel export
│   └── [Feature]Card.tsx
├── hooks/
│   ├── index.ts        # Barrel export
│   ├── use[Feature].ts
│   └── use[Feature]Store.ts
└── lib/
    └── [domain]/       # Domain logic
```

Example from `/timer/`:
- `useTimerStore.ts` - Collection state
- `useTimer.ts` - Single item state
- `useTimerEngine.ts` - Tick loop
- `useCrossTabSync.ts` - Cross-tab state sync

## Zod Schemas for Types

Define types via Zod schemas for runtime validation:

```tsx
// packages/shared/src/types/timer.ts
import { z } from 'zod'

export const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  timerType: z.enum(['stopwatch', 'countdown', 'pomodoro']),
  isRunning: z.boolean(),
  elapsedTime: z.number(),
  duration: z.number().optional(),
  // ...
})

export type Timer = z.infer<typeof timerSchema>

// Input schema (omit auto-generated fields)
export const timerInputSchema = timerSchema.omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
})

export type TimerInput = z.infer<typeof timerInputSchema>
```

## Auth Guard Pattern

Redirect unauthenticated users:

```tsx
// src/routes/index.tsx
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { Navigate } from '@tanstack/react-router'

function IndexPage() {
  const { isLoading, user } = useAuth()

  if (isLoading) return <Loader />
  if (user) return <Navigate to="/dashboard" />
  return <Navigate to="/auth/signin" />
}
```

## Layout Components

Wrap pages with consistent layout:

```tsx
// src/routes/dashboard/index.tsx
import { DashboardLayout } from '@/components/dashboard'

function DashboardPage() {
  return (
    <DashboardLayout title="Dashboard" description="Your command center">
      {/* Page content */}
    </DashboardLayout>
  )
}
```

## Class Variance Authority (CVA)

Button/component variants:

```tsx
// src/components/ui/button.tsx
import { cva, type VariantProps } from 'class-variance-authority'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline: 'border bg-background hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        lg: 'h-10 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)
```

## Settings Persistence

Singleton pattern with localStorage:

```tsx
// src/hooks/useSettings.ts
let globalSettings = loadSettings()
const listeners = new Set<() => void>()

export function useSettings() {
  const [settings, setSettingsState] = useState(globalSettings)

  useEffect(() => {
    const listener = () => setSettingsState({ ...globalSettings })
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    globalSettings = { ...globalSettings, [key]: value }
    saveSettings(globalSettings)
    listeners.forEach(l => l())  // Notify all subscribers
  }

  return { settings, updateSetting }
}
```

## Animation Timing

Staggered animations on lists:

```tsx
{items.map((item, index) => (
  <div
    key={item.id}
    className="animate-slide-up"
    style={{ animationDelay: `${index * 50}ms` }}
  >
    <Card item={item} />
  </div>
))}
```

## Error Handling Pattern

Consistent error types:

```tsx
export type AuthError = {
  code: string
  message: string
  email?: string
  pendingAuthenticationToken?: string
}

// In handlers
try {
  const result = await apiCall()
  return { success: true, data: result }
} catch (error) {
  return handleError(error)  // Returns AuthError
}
```

## NO useCallback/useMemo

React Compiler handles memoization automatically. Just write plain functions:

```tsx
// DO THIS
function MyComponent() {
  const handleClick = () => doSomething()
  return <Button onClick={handleClick}>Click</Button>
}

// DON'T DO THIS (unnecessary with React Compiler)
function MyComponent() {
  const handleClick = useCallback(() => doSomething(), [])
  return <Button onClick={handleClick}>Click</Button>
}
```
