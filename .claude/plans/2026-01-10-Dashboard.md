## Project Overview

Create a personal dashboard application as a monorepo with:

- **Web App**: TanStack Start with WorkOS authentication, cyberpunk-themed UI
- **Server**: Nitro-based API with WebSocket support for real-time sync
- **Shared Package**: Common utilities for both web and server
- **Timer Feature**: Recreate the CHRONO timer (cyberpunk multi-timer) in React

## Design Decisions

- **Existing apps**: Keep docs/, move web-template/ to __unused_web-template/
- **Timer storage**: Both localStorage (offline) + server persistence via WebSocket
- **Auth UI**: Cyberpunk theme ported from Rewind (neon/glassmorphism)

## Architecture

```
src/dashboard/
├── __unused_web-template/   # Archived Next.js template (for reference)
├── apps/
│   ├── docs/                # Keep existing docs app
│   ├── web/                 # TanStack Start app (from decide/tanstack-start/)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── __root.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   ├── timer/
│   │   │   │   │   └── index.tsx        # Timer page
│   │   │   │   ├── auth/
│   │   │   │   │   ├── signin.tsx
│   │   │   │   │   ├── signup.tsx
│   │   │   │   │   ├── forgot-password.tsx
│   │   │   │   │   └── reset-password.tsx
│   │   │   │   └── (protected)/         # Auth-required routes
│   │   │   ├── components/
│   │   │   │   ├── timer/               # Timer components
│   │   │   │   └── auth/                # Auth components
│   │   │   └── lib/
│   │   └── .env.local
│   │
│   └── server/              # Nitro server
│       ├── routes/
│       │   ├── api/
│       │   │   ├── health.ts
│       │   │   ├── timer/[id].ts
│       │   │   └── user/index.ts
│       │   └── _ws.ts       # WebSocket handler
│       ├── utils/
│       └── nitro.config.ts
│
└── packages/
    ├── shared/              # Shared utilities
    │   ├── src/
    │   │   ├── types/
    │   │   ├── utils/
    │   │   └── constants/
    │   └── package.json
    ├── ui/                  # Existing - will extend
    ├── eslint-config/
    ├── typescript-config/
    └── tailwind-config/
```

## Implementation Phases

### Phase 0: Branch Creation & Initial Commit ✓

**Status**: User already created turborepo in src/dashboard/

1. Create feature/dashboard branch
2. Commit existing turborepo structure with `feat(dashboard): Init turborepo`

### Phase 1: TanStack Start Setup

**Files to copy**: `decide/tanstack-start/` → `src/dashboard/apps/web/`

1. Copy entire decide/tanstack-start/ to apps/web/
2. Update package.json name to `@dashboard/web`
3. Configure workspace references
4. Copy WorkOS env variables from Rewind project:
5. Commit with `feat(dashboard): Init tanstack-start project in turborepo`

### Phase 2: Shared Package

**Location**: `src/dashboard/packages/shared/`

Create shared utilities package with:

- Timer types and interfaces
- Common constants
- Utility functions (time formatting, etc.)
- Zod schemas for validation

```typescript
// packages/shared/src/types/timer.ts
export interface Timer {
  id: string
  name: string
  type: 'stopwatch' | 'countdown'
  isRunning: boolean
  pausedTime: number
  countdownDuration: number
  laps: number[]
  // ... more fields
}
```

### Phase 3: Nitro Server Setup

**Location**: `src/dashboard/apps/server/`

Initialize Nitro server with:

```bash
cd src/dashboard/apps/server
bunx giget nitro .
```

**Routes to create**:

- `GET /api/health` - Health check
- `GET /api/timers` - List timers (from DB/localStorage sync)
- `POST /api/timers` - Create timer
- `PUT /api/timers/:id` - Update timer
- `DELETE /api/timers/:id` - Delete timer
- `GET /api/user` - Get current user (WorkOS session)
- `POST /api/auth/verify` - Verify WorkOS token

**WebSocket handler** (`_ws.ts`):

- Real-time timer sync across clients
- Presence awareness
- Timer state broadcasting

### Phase 4: Authentication System (Cyberpunk Theme)

Adapt Rewind auth patterns for TanStack Start with full cyberpunk styling:

**Key differences from Next.js**:

- TanStack Start uses AuthKit-React provider (already in template)
- No server actions - use API routes instead
- Client-side form handling with TanStack Form

**Routes to create**:

- `/auth/signin` - Email/password + OAuth login
- `/auth/signup` - Registration with verification
- `/auth/forgot-password` - Password reset request
- `/auth/reset-password` - Complete password reset
- `/auth/callback` - OAuth redirect handler
- `/auth/error` - Auth error display

**Cyberpunk UI Elements to Port from Rewind**:

- Glass-morphism cards with backdrop blur
- Neon glow effects (amber, cyan)
- Animated gradient orbs (`animate-pulse`)
- Cyber grid background with scan lines
- Time ripple animations
- Tech corner decorations
- Gradient text for branding

**Components to adapt from Rewind**:

- `email-verification-form.tsx` - OTP input with cyberpunk styling
- `error-page.tsx` - Auth error with glitch effects
- Auth layout with animated background

### Phase 5: Timer Feature

**Location**: `src/dashboard/apps/web/src/routes/timer/`

Recreate CHRONO timer in React with full server sync:

**Core Components**:

```
timer/
├── index.tsx              # Timer page route
├── components/
│   ├── TimerCard.tsx      # Individual timer
│   ├── TimerDisplay.tsx   # Time display with glow
│   ├── TimerControls.tsx  # Start/Pause/Lap/Reset
│   ├── TimerTypeSwitch.tsx # Stopwatch/Countdown toggle
│   ├── LapsContainer.tsx  # Lap history
│   ├── CountdownInput.tsx # Duration input
│   └── EmptyState.tsx     # No timers message
├── hooks/
│   ├── useTimer.ts        # Timer logic hook
│   ├── useTimerStore.ts   # TanStack Store for state management
│   ├── useTimerCollection.ts # PowerSync collection queries
│   └── usePowerSync.ts    # PowerSync connection management
├── lib/
│   ├── timer-engine.ts    # RAF-based tick engine
│   └── time-utils.ts      # Formatting functions
└── styles.css             # Cyberpunk CSS
```

**Key Features to Implement**:

1. Multiple timers with unique IDs
2. Stopwatch (count up) and Countdown (count down) modes
3. Start/Pause/Reset/Lap controls
4. Pop-out window mode (`?timer={id}`)
5. Offline-first with SQLite (PowerSync)
6. Automatic bi-directional sync across devices (PowerSync)
7. Countdown completion flash animation
8. Cyberpunk UI with neon glow effects

**Sync Architecture** (using TanStack Store + PowerSync):

- TanStack Store for reactive state management
- PowerSync for offline-first SQLite persistence with automatic sync
- Optimistic updates with automatic rollback on sync errors
- Real-time bi-directional sync across devices
- User-scoped timers (requires authentication)

**PowerSync Setup**:

```typescript
// src/db/powersync.ts
import { PowerSyncDatabase, Schema, Table, column } from '@powersync/web'
import '@journeyapps/wa-sqlite'

export const APP_SCHEMA = new Schema({
  timers: new Table({
    name: column.text,
    type: column.text,          // 'stopwatch' | 'countdown'
    is_running: column.integer, // boolean as 0/1
    paused_time: column.integer,
    countdown_duration: column.integer,
    laps: column.text,          // JSON stringified array
    user_id: column.text,
    created_at: column.text,
    updated_at: column.text,
  }),
})

export const db = new PowerSyncDatabase({
  database: { dbFilename: 'dashboard.sqlite' },
  schema: APP_SCHEMA,
})
```

**TanStack DB Collection with PowerSync**:

```typescript
// src/db-collections/timers.ts
import { createCollection } from '@tanstack/react-db'
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection'
import { z } from 'zod'
import { db, APP_SCHEMA } from '../db/powersync'

const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['stopwatch', 'countdown']),
  is_running: z.number().transform(val => val > 0),  // SQLite int → boolean
  paused_time: z.number(),
  countdown_duration: z.number(),
  laps: z.string().transform(val => JSON.parse(val || '[]')), // JSON → array
  user_id: z.string(),
  created_at: z.string().transform(val => new Date(val)),
  updated_at: z.string().transform(val => new Date(val)),
})

export const timersCollection = createCollection(
  powerSyncCollectionOptions({
    database: db,
    table: APP_SCHEMA.props.timers,
    schema: timerSchema,
    serializer: {
      is_running: (val: boolean) => val ? 1 : 0,
      laps: (val: number[]) => JSON.stringify(val),
      created_at: (val: Date) => val.toISOString(),
      updated_at: (val: Date) => val.toISOString(),
    },
  })
)
```

**PowerSync Backend Connector** (for server sync):

```typescript
// src/db/powersync-connector.ts
import { PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web'

export class DashboardConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    // Get token from WorkOS session and exchange for PowerSync credentials
    const response = await fetch('/api/auth/powersync-token')
    return response.json()
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Upload pending changes to Nitro server
    const batch = await database.getCrudBatch(100)
    if (batch) {
      await fetch('/api/sync/upload', {
        method: 'POST',
        body: JSON.stringify(batch.crud),
      })
      await batch.complete()
    }
  }
}
```

### Phase 6: Tailwind Configuration

Copy and adapt from Rewind:

```
Rewind/apps/timetravel-web/tailwind.config.js → src/dashboard/apps/web/tailwind.config.ts
```

**Custom classes needed for timer**:

- `.glass-card` - Glassmorphism
- `.neon-amber`, `.neon-cyan` - Glow effects
- `.cyber-grid`, `.scan-lines` - Background effects
- Animation keyframes: `fadeInUp`, `pulseGlow`, `flash`, `flicker`

### Phase 7: Frontend Routes

Create additional dashboard routes:

- `/` - Dashboard home
- `/timer` - Timer application
- `/settings` - User settings
- `/profile` - User profile

## Critical Files Reference

### From Rewind (Auth):

- `/Users/Martin/Tresors/Projects/Rewind/apps/timetravel-web/lib/actions/auth.ts`
- `/Users/Martin/Tresors/Projects/Rewind/apps/timetravel-web/lib/auth.ts`
- `/Users/Martin/Tresors/Projects/Rewind/apps/timetravel-web/components/auth/email-verification-form.tsx`
- `/Users/Martin/Tresors/Projects/Rewind/apps/timetravel-web/app/(auth)/*.tsx`

### From TanStack Start Template:

- `/Users/Martin/Tresors/Projects/GenesisTools/decide/tanstack-start/src/integrations/workos/provider.tsx`
- `/Users/Martin/Tresors/Projects/GenesisTools/decide/tanstack-start/src/components/workos-user.tsx`
- `/Users/Martin/Tresors/Projects/GenesisTools/decide/tanstack-start/src/routes/demo/workos.tsx`

### Timer Reference:

- Download and save to: `src/dashboard/timer/index.static.html`
- Source: [https://foltyn.dev/timer/index.html](https://foltyn.dev/timer/index.html)
- Use `curl -o src/dashboard/timer/index.static.html https://foltyn.dev/timer/index.html`

# AI (optional)

ANTHROPIC_API_KEY=

```

### apps/server/.env
```env
WORKOS_API_KEY=
PORT=4000
```

## CLAUDE.md Updates

Add to project CLAUDE.md:

```markdown
## Context7 Documentation References

When working with the dashboard project, use these context7 library IDs for documentation:

- **TanStack Start**: `/websites/tanstack_start_framework_react`
- **TanStack Start + WorkOS Auth**: `/workos/authkit-tanstack-start`
- **Motia (Backend framework)**: `/motiadev/motia`
- **shadcn/ui components**: `/websites/ui_shadcn`
- **Turborepo**: `/websites/turborepo`
- **TanStack Query**: `/websites/tanstack_query`
- **TanStack DB**: `/tanstack/db`
- **TanStack Router**: `/websites/tanstack_router`

Use with: `mcp-cli call plugin_context7_context7/query-docs '{"libraryId": "<id>", "topic": "..."}'`

## PowerSync Documentation

For offline-first sync with TanStack DB, refer to:
- https://tanstack.com/db/latest/docs/collections/powersync-collection

Packages: `@tanstack/powersync-db-collection @powersync/web @journeyapps/wa-sqlite`
```

## Verification Steps

1. **Build Check**: `cd src/dashboard && bun run build`
2. **Type Check**: `cd src/dashboard && bun run check-types`
3. **Dev Server**: `cd src/dashboard && bun run dev`
4. **Web App**: Access [http://localhost:3000](http://localhost:3000)
5. **Timer Route**: Access [http://localhost:3000/timer](http://localhost:3000/timer)
6. **Auth Flow**: Test signin/signup/logout
7. **Server API**: Access [http://localhost:4000/api/health](http://localhost:4000/api/health)
8. **WebSocket**: Test timer sync across tabs

## Commit Sequence

### Phase 0: Setup

1. `git checkout -b feature/dashboard`
2. `git add src/dashboard/ && git commit -m "feat(dashboard): Init turborepo"`

### Phase 1: TanStack Start Setup

1. Move web-template: `git mv src/dashboard/apps/web-template src/dashboard/__unused_web-template && git commit -m "chore(dashboard): Archive web-template app"`
2. Copy tanstack-start to apps/web/: `git commit -m "feat(dashboard): Copy tanstack-start template to apps/web"`
3. Update package.json name and workspace refs: `git commit -m "chore(dashboard): Configure web app workspace references"`
4. Add .env.local with WorkOS vars: `git commit -m "feat(dashboard): Add WorkOS environment configuration"`

### Phase 2: Shared Package

1. Create packages/shared scaffold: `git commit -m "feat(dashboard): Add shared utilities package scaffold"`
2. Add timer types and schemas: `git commit -m "feat(dashboard): Add timer types and Zod schemas"`

### Phase 3: Nitro Server

1. Initialize Nitro app: `git commit -m "feat(dashboard): Initialize Nitro server"`
2. Add health and basic API routes: `git commit -m "feat(dashboard): Add server health and user API routes"`
3. Add timer API routes: `git commit -m "feat(dashboard): Add timer CRUD API routes"`
4. Add PowerSync sync endpoints: `git commit -m "feat(dashboard): Add PowerSync sync endpoints"`

### Phase 4: Authentication

1. Add auth layout with cyberpunk theme: `git commit -m "feat(dashboard): Add cyberpunk auth layout"`
2. Add signin page: `git commit -m "feat(dashboard): Add signin page with OAuth"`
3. Add signup page: `git commit -m "feat(dashboard): Add signup page with email verification"`
4. Add forgot/reset password pages: `git commit -m "feat(dashboard): Add password reset flow"`
5. Add auth callback handler: `git commit -m "feat(dashboard): Add OAuth callback handler"`

### Phase 5: Timer Feature

1. Download static timer reference: `git commit -m "docs(dashboard): Add static timer reference"`
2. Add PowerSync database setup: `git commit -m "feat(dashboard): Add PowerSync database configuration"`
3. Add timer collection with TanStack DB: `git commit -m "feat(dashboard): Add timer PowerSync collection"`
4. Add timer components: `git commit -m "feat(dashboard): Add timer UI components"`
5. Add timer page route: `git commit -m "feat(dashboard): Add timer page with full functionality"`
6. Add cyberpunk timer styles: `git commit -m "style(dashboard): Add cyberpunk timer CSS"`

### Phase 6: Configuration

1. Copy and adapt Tailwind config: `git commit -m "chore(dashboard): Configure Tailwind with cyberpunk theme"`

### Phase 7: Documentation

1. Update CLAUDE.md: `git commit -m "docs: Add context7 and PowerSync documentation references"`

## Dependencies to Install

### apps/web (additional)

```bash
bun add @tanstack/react-store @tanstack/react-db @tanstack/powersync-db-collection @powersync/web @journeyapps/wa-sqlite iron-session zod
```

**Note**:

- TanStack Store for state management (already in tanstack-start template)
- PowerSync for offline-first SQLite with automatic sync
- @journeyapps/wa-sqlite for WASM SQLite in browser

### apps/server

```bash
bun add nitropack @workos-inc/node
```

**Note**: Nitro includes `h3` as a core dependency - no need to install separately. WebSocket support is built into Nitro via the `_ws.ts` route convention.

### packages/shared

```bash
bun add zod
```

