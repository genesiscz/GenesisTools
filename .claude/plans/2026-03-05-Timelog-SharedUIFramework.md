# Shared UI Framework — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract reusable UI components, theme, and Vite config from `src/claude-history-dashboard/` into `src/utils/ui/`, so any tool can spin up a themed dashboard with ~100 lines of code.

**Architecture:** Shared package at `src/utils/ui/` with components, theme CSS, base Vite config, and a `createDashboardApp()` factory. Each tool dashboard is a thin Vite app importing from the shared package. No monorepo tooling needed — Bun handles path resolution natively.

**Tech Stack:** React 19, Vite 7, TanStack Router + Query, Tailwind CSS 4, CVA, Radix UI, Biome

---

## Phase 1: Extract Shared UI Package

### Task 1: Create shared UI directory structure

**Files:**
- Create: `src/utils/ui/components/` (copy from claude-history-dashboard)
- Create: `src/utils/ui/theme/`
- Create: `src/utils/ui/lib/`
- Create: `src/utils/ui/layouts/`
- Create: `src/utils/ui/index.ts`

**Step 1: Extract theme files**

Copy and adapt from `src/claude-history-dashboard/src/`:
- `styles.css` → `src/utils/ui/theme/styles.css`
- `cyberpunk.css` → `src/utils/ui/theme/cyberpunk.css`

These are already standalone and portable.

**Step 2: Extract UI components**

Copy from `src/claude-history-dashboard/src/components/ui/`:
- `card.tsx`, `button.tsx`, `badge.tsx`, `skeleton.tsx`
- `input.tsx`, `scroll-area.tsx`, `dialog.tsx`, `command.tsx`
- `date-range-picker.tsx`

All → `src/utils/ui/components/`

These components use CVA variants and are already decoupled from domain logic.

**Step 3: Extract utility**

Copy `src/claude-history-dashboard/src/lib/utils.ts` → `src/utils/ui/lib/utils.ts`

The `cn()` function (clsx + tailwind-merge).

**Step 4: Commit**

```bash
git add src/utils/ui/
git commit -m "feat(ui): extract shared UI components, theme, and utilities from claude-history-dashboard"
```

### Task 2: Create shared layout component

**Files:**
- Create: `src/utils/ui/layouts/DefaultLayout.tsx`

**Step 1: Implement configurable layout**

```tsx
// src/utils/ui/layouts/DefaultLayout.tsx
import type { ReactNode } from "react";

export interface DashboardLayoutProps {
  title: string;           // e.g. "CLARITY::TIMELOG"
  subtitle?: string;
  navLinks?: { label: string; href: string }[];
  children: ReactNode;
}

export function DashboardLayout({ title, subtitle, navLinks, children }: DashboardLayoutProps) {
  // Renders:
  // - Sticky glass-card header with neon border
  // - Title in monospace with amber glow
  // - Navigation links (active state)
  // - Ambient glow blurs (background)
  // - Scan lines overlay
  // - {children} as main content area
}
```

This extracts the pattern from `claude-history-dashboard/src/routes/__root.tsx` and `Header.tsx` into a reusable layout.

**Step 2: Commit**

```bash
git add src/utils/ui/layouts/
git commit -m "feat(ui): add configurable DashboardLayout component"
```

### Task 3: Create base Vite config

**Files:**
- Create: `src/utils/ui/vite.base.ts`

**Step 1: Extract Vite config factory**

```typescript
// src/utils/ui/vite.base.ts
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export interface DashboardViteConfig {
  /** Root directory of the dashboard app */
  root: string;
  /** Dev server port */
  port: number;
  /** Additional Vite config overrides */
  overrides?: Partial<UserConfig>;
}

export function createDashboardViteConfig(config: DashboardViteConfig): UserConfig {
  return defineConfig({
    root: config.root,
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      port: config.port,
    },
    resolve: {
      alias: {
        "@ui": resolve(__dirname, "."),
        "@app": resolve(config.root, "src"),
      },
    },
    ...config.overrides,
  });
}
```

Each tool dashboard's `vite.config.ts` becomes:

```typescript
// src/clarity/ui/vite.config.ts
import { createDashboardViteConfig } from "../../utils/ui/vite.base.js";

export default createDashboardViteConfig({
  root: __dirname,
  port: 3070,
});
```

**Step 2: Commit**

```bash
git add src/utils/ui/vite.base.ts
git commit -m "feat(ui): add base Vite config factory for dashboard apps"
```

### Task 4: Create app factory

**Files:**
- Create: `src/utils/ui/create-app.tsx`

**Step 1: Implement createDashboardApp()**

```tsx
// src/utils/ui/create-app.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../ui/theme/styles.css";
import "../ui/theme/cyberpunk.css";

export interface DashboardAppConfig {
  /** The root React component (typically a Router) */
  App: React.ComponentType;
  /** Root element ID (default: "root") */
  rootId?: string;
}

export function createDashboardApp(config: DashboardAppConfig) {
  const queryClient = new QueryClient();
  const root = document.getElementById(config.rootId ?? "root");
  if (!root) throw new Error("Root element not found");

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <config.App />
      </QueryClientProvider>
    </StrictMode>
  );
}
```

A new dashboard's `main.tsx` becomes:

```tsx
// src/clarity/ui/src/main.tsx
import { createDashboardApp } from "../../../utils/ui/create-app.js";
import { App } from "./App.js";

createDashboardApp({ App });
```

**Step 2: Commit**

```bash
git add src/utils/ui/create-app.tsx
git commit -m "feat(ui): add createDashboardApp factory for thin app bootstrapping"
```

### Task 5: Export barrel file

**Files:**
- Create: `src/utils/ui/index.ts`

**Step 1: Create main export**

```typescript
// src/utils/ui/index.ts
// Components
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction } from "./components/card.js";
export { Button, buttonVariants } from "./components/button.js";
export { Badge, badgeVariants } from "./components/badge.js";
export { Skeleton } from "./components/skeleton.js";
export { Input } from "./components/input.js";
export { ScrollArea, ScrollBar } from "./components/scroll-area.js";
export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose } from "./components/dialog.js";

// Layout
export { DashboardLayout } from "./layouts/DefaultLayout.js";

// Utilities
export { cn } from "./lib/utils.js";

// App factory
export { createDashboardApp } from "./create-app.js";
export type { DashboardAppConfig } from "./create-app.js";

// Vite config
export { createDashboardViteConfig } from "./vite.base.js";
export type { DashboardViteConfig } from "./vite.base.js";
```

**Step 2: Commit**

```bash
git add src/utils/ui/index.ts
git commit -m "feat(ui): add barrel export for shared UI package"
```

---

## Phase 2: Migrate claude-history-dashboard

### Task 6: Update claude-history-dashboard imports

**Files:**
- Modify: `src/claude-history-dashboard/src/components/` — update imports to `@ui/`
- Modify: `src/claude-history-dashboard/src/routes/__root.tsx` — use DashboardLayout
- Modify: `src/claude-history-dashboard/vite.config.ts` — use `createDashboardViteConfig`
- Modify: `src/claude-history-dashboard/src/main.tsx` — use `createDashboardApp`

**Step 1: Update Vite config**

```typescript
// src/claude-history-dashboard/vite.config.ts
import { createDashboardViteConfig } from "../utils/ui/vite.base.js";
// ... plus TanStack Router plugin (tool-specific)

export default createDashboardViteConfig({
  root: __dirname,
  port: 3069,
  overrides: {
    plugins: [/* TanStack router plugin, devtools */],
  },
});
```

**Step 2: Update component imports**

Change all `from "../ui/card"` → `from "@ui/components/card"` etc.

**Step 3: Update root layout to use DashboardLayout**

**Step 4: Verify everything still works**

```bash
cd src/claude-history-dashboard && bun run dev
# Verify UI looks identical on http://localhost:3069
```

**Step 5: Commit**

```bash
git add src/claude-history-dashboard/
git commit -m "refactor(claude-history): migrate to shared UI framework"
```

---

## Phase 3: Hello World Template

### Task 7: Create minimal example dashboard

**Files:**
- Create: `src/utils/ui/examples/hello-world/` (or just document the pattern)

**Step 1: Document the minimal setup**

A new tool dashboard needs exactly these files:

```
src/<tool>/ui/
├── vite.config.ts     # ~5 lines (extends base)
├── index.html         # ~10 lines (standard HTML)
├── package.json       # ~15 lines (deps + scripts)
└── src/
    ├── main.tsx       # ~5 lines (createDashboardApp)
    └── App.tsx        # ~30 lines (DashboardLayout + routes)
```

Total: ~65 lines of tool-specific code for a fully themed dashboard.

**Step 2: Commit**

```bash
git add src/utils/ui/
git commit -m "docs(ui): add minimal dashboard template documentation"
```

---

## Shared Dependencies

The shared UI package requires these peer dependencies (installed at tool level):

```json
{
  "react": "^19",
  "react-dom": "^19",
  "@tanstack/react-router": "^1.132",
  "@tanstack/react-query": "^5.66",
  "@radix-ui/react-dialog": "^1",
  "@radix-ui/react-scroll-area": "^1",
  "@radix-ui/react-slot": "^1",
  "class-variance-authority": "^0.7",
  "clsx": "^2",
  "tailwind-merge": "^3",
  "lucide-react": "^0.4",
  "cmdk": "^1",
  "tailwindcss": "^4",
  "@tailwindcss/vite": "^4",
  "@vitejs/plugin-react": "^4",
  "vite": "^7"
}
```
