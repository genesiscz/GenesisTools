# Routing

> TanStack Router with file-based routes

## File-Based Routing

Routes are in `src/routes/` and auto-generated in `src/routeTree.gen.ts`.

## Route Tree

```
/                      # index.tsx (auth redirect)
/auth/
  signin               # auth/signin.tsx
  signup               # auth/signup.tsx
  callback             # auth/callback.tsx
  forgot-password      # auth/forgot-password.tsx
  reset-password       # auth/reset-password.tsx
  error                # auth/error.tsx
/dashboard/
  /                    # dashboard/index.tsx
  ai                   # dashboard/ai.tsx
  focus                # dashboard/focus.tsx
  notes                # dashboard/notes.tsx
  bookmarks            # dashboard/bookmarks.tsx
  planner              # dashboard/planner.tsx
/timer/
  /                    # timer/index.tsx
/timer/$timerId        # timer.$timerId.tsx (dynamic)
/profile               # profile.tsx
/settings              # settings.tsx
/api/trpc/*            # api.trpc.$.tsx (tRPC handler)
/demo/*                # demo pages (examples)
```

## Route Patterns

### Basic Route

```tsx
// src/routes/dashboard/index.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/')({
  component: DashboardPage,
})

function DashboardPage() {
  return <div>Dashboard</div>
}
```

### Dynamic Route

```tsx
// src/routes/timer.$timerId.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/timer/$timerId')({
  component: TimerDetailPage,
})

function TimerDetailPage() {
  const { timerId } = Route.useParams()
  return <div>Timer: {timerId}</div>
}
```

### Search Params

```tsx
import { createFileRoute, useSearch } from '@tanstack/react-router'

export const Route = createFileRoute('/auth/signin')({
  component: SignInPage,
  validateSearch: (search: Record<string, unknown>) => ({
    reset: search.reset === 'success',
  }),
})

function SignInPage() {
  const { reset } = useSearch({ from: '/auth/signin' })
}
```

### Root Layout

```tsx
// src/routes/__root.tsx
import { createRootRouteWithContext } from '@tanstack/react-router'

interface MyRouterContext {
  queryClient: QueryClient
  trpc: TRPCOptionsProxy<TRPCRouter>
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [...],
    links: [...],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html>
      <head><HeadContent /></head>
      <body>
        <WorkOSProvider>
          {children}
          <Toaster />
          <TanStackDevtools />
        </WorkOSProvider>
        <Scripts />
      </body>
    </html>
  )
}
```

## API Routes

API routes use `api.*.ts` naming pattern:

```tsx
// src/routes/demo/api.names.ts
import { createAPIFileRoute } from '@tanstack/react-start/api'

export const APIRoute = createAPIFileRoute('/demo/api/names')({
  GET: async () => {
    return Response.json(['John', 'Jane'])
  },
})
```

## Navigation

```tsx
import { Link, useNavigate } from '@tanstack/react-router'

// Declarative
<Link to="/dashboard">Go to Dashboard</Link>
<Link to="/timer/$timerId" params={{ timerId: '123' }}>Timer</Link>

// Programmatic
const navigate = useNavigate()
await navigate({ to: '/dashboard' })
```

## Router Setup

From `src/router.tsx`:

```tsx
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

export const getRouter = () => {
  const rqContext = TanstackQuery.getContext()
  const router = createRouter({
    routeTree,
    context: { ...rqContext },
    defaultPreload: 'intent',  // Preload on hover
  })
  setupRouterSsrQueryIntegration({ router, queryClient: rqContext.queryClient })
  return router
}
```

## Auth Middleware

From `src/start.ts`:

```tsx
import { createStart } from '@tanstack/react-start'
import { authkitMiddleware } from '@workos/authkit-tanstack-react-start'

export const startInstance = createStart(() => ({
  requestMiddleware: [authkitMiddleware()],
}))
```
