# dev-dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/dev-dashboard/` — a GenesisTools web dashboard at `http://localhost:3042` (also reachable at `https://mac.foltyn.dev` through the existing Cloudflare Tunnel) with three panels (ttyd splits, cmux live view, obsidian read+publish), gated by Cloudflare Access.

**Architecture:** TanStack Router SPA (mirrors `src/claude-history-dashboard/` scaffolding) served by Vite on :3042. Vite middleware exposes `/api/*` for the three panels' server-side logic and `/share/:slug` for public Obsidian-published notes. Tunnel adds one ingress rule under the existing `mac.foltyn.dev` hostname; the existing `/telegram-webhook` rule stays first and unchanged. Cloudflare Access gates everything except `/telegram-webhook` and `/share/*`.

**Tech Stack:** Bun · TanStack Router · React 19 (compiler) · Vite · Tailwind v4 · shadcn (consumed from `src/utils/ui/`) · Zod · marked v17 · ttyd (already installed at `/opt/homebrew/bin/ttyd`) · react-mosaic-component (to install) · cmux JSON-RPC socket (existing wrapper `src/cmux/lib/socket.ts`).

**Source spec:** `.claude/plans/2026-05-15-dev-dashboard.design.md` — that document is the source of truth; this plan only decomposes it into bite-sized steps.

---

## File Structure

Files this plan creates or modifies:

**Created:**
- `src/dev-dashboard/index.ts` — Commander entry; `tools dev-dashboard` launches the UI via Vite spawn.
- `src/dev-dashboard/config.ts` — Zod schema + `Storage("dev-dashboard")` persistence.
- `src/dev-dashboard/README.md` — minimal tool docs (matches conventions).
- `src/dev-dashboard/lib/ttyd/types.ts` — `TtydSession`, `SplitNode`.
- `src/dev-dashboard/lib/ttyd/free-port.ts` — async free-port helper (Node `net` server trick).
- `src/dev-dashboard/lib/ttyd/manager.ts` — spawn/list/kill registry.
- `src/dev-dashboard/lib/ttyd/manager.test.ts`
- `src/dev-dashboard/lib/cmux/types.ts` — `CmuxSnapshot`, `Pane`, `Surface`.
- `src/dev-dashboard/lib/cmux/client.ts` — wraps `rpc()` from `@app/cmux/lib/socket`.
- `src/dev-dashboard/lib/cmux/client.test.ts`
- `src/dev-dashboard/lib/cmux/poller.ts` — interval cache.
- `src/dev-dashboard/lib/obsidian/types.ts` — `PublishedNote`, `VaultEntry`.
- `src/dev-dashboard/lib/obsidian/reader.ts` — vault list + read.
- `src/dev-dashboard/lib/obsidian/markdown.ts` — marked + wikilink rewrite.
- `src/dev-dashboard/lib/obsidian/markdown.test.ts`
- `src/dev-dashboard/lib/obsidian/publish.ts` — slug, publish/unpublish, registry.
- `src/dev-dashboard/lib/obsidian/publish.test.ts`
- `src/dev-dashboard/ui/index.html`
- `src/dev-dashboard/ui/package.json` — minimal (only `name` + per-dir overrides if any; deps are root-level).
- `src/dev-dashboard/ui/biome.json` — extends root.
- `src/dev-dashboard/ui/tsconfig.json` — mirrors chd's tsconfig.
- `src/dev-dashboard/ui/vite.config.ts` — `createDashboardViteConfig({ port: 3042, ... })` plus `server.middlewares` for `/api/*` and `/share/:slug`.
- `src/dev-dashboard/ui/vite-middleware.ts` — wires the `/api/*` and `/share/:slug` handlers into Vite.
- `src/dev-dashboard/ui/src/main.tsx`
- `src/dev-dashboard/ui/src/router.tsx`
- `src/dev-dashboard/ui/src/styles.css` — tailwind + slate-grid theme variables.
- `src/dev-dashboard/ui/src/slate-grid.css` — theme tokens.
- `src/dev-dashboard/ui/src/routes/__root.tsx` — Shell (Sidebar + outlet).
- `src/dev-dashboard/ui/src/routes/index.tsx` — default route (redirect to /ttyd).
- `src/dev-dashboard/ui/src/routes/ttyd.tsx`
- `src/dev-dashboard/ui/src/routes/cmux.tsx`
- `src/dev-dashboard/ui/src/routes/obsidian.tsx`
- `src/dev-dashboard/ui/src/components/Sidebar.tsx`
- `src/dev-dashboard/ui/src/components/TtydPane.tsx`
- `src/dev-dashboard/ui/src/components/CmuxSessionList.tsx`
- `src/dev-dashboard/ui/src/components/ObsidianTree.tsx`
- `src/dev-dashboard/ui/src/components/ObsidianReader.tsx`
- `src/dev-dashboard/ui/src/lib/api.ts` — fetch wrappers around `/api/*`.

**Modified:**
- `~/.cloudflared/config.yml` — append `mac.foltyn.dev → http://127.0.0.1:3042` ingress rule (after the existing telegram-webhook rule).
- `package.json` — `bun add react-mosaic-component @types/react-mosaic-component` (root level).

**Not in code (manual / one-time):**
- Cloudflare Zero Trust dashboard: create an Access Application gating `mac.foltyn.dev` with bypass paths for `/telegram-webhook` and `/share/*`, allowing `martin@foltyn.dev`.

---

## Task 1: Scaffold the tool entry + config

**Files:**
- Create: `src/dev-dashboard/index.ts`
- Create: `src/dev-dashboard/config.ts`
- Create: `src/dev-dashboard/README.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/dev-dashboard/lib/ttyd src/dev-dashboard/lib/cmux src/dev-dashboard/lib/obsidian src/dev-dashboard/ui/src/routes src/dev-dashboard/ui/src/components src/dev-dashboard/ui/src/lib
```

- [ ] **Step 2: Write `src/dev-dashboard/config.ts`**

```ts
import { chmod } from "node:fs/promises";
import { Storage } from "@app/utils/storage/storage";
import { z } from "zod";

const PublishedNoteSchema = z.object({
    slug: z.string(),
    vaultPath: z.string(),
    publishedAt: z.string(),
});

const DevDashboardConfigSchema = z.object({
    port: z.number().int().min(1).max(65535).default(3042),
    obsidianVault: z.string().default("/Users/Martin/Tresors/Projects/GenesisBrain"),
    publishedNotes: z.array(PublishedNoteSchema).default([]),
    cmuxPollIntervalMs: z.number().int().min(250).default(2000),
});

export type PublishedNote = z.infer<typeof PublishedNoteSchema>;
export type DevDashboardConfig = z.infer<typeof DevDashboardConfigSchema>;

const storage = new Storage("dev-dashboard");

export async function getConfig(): Promise<DevDashboardConfig> {
    const raw = await storage.getConfig<DevDashboardConfig>();
    const parsed = DevDashboardConfigSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : DevDashboardConfigSchema.parse({});
}

export async function saveConfig(config: DevDashboardConfig): Promise<void> {
    DevDashboardConfigSchema.parse(config);
    await storage.ensureDirs();
    await storage.setConfig(config);
    if (process.platform !== "win32") {
        await chmod(storage.getConfigPath(), 0o600);
    }
}
```

- [ ] **Step 3: Write `src/dev-dashboard/index.ts` (Commander entry, mirrors `src/clarity/index.ts`)**

```ts
#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "@app/logger";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";
import { getConfig } from "./config";

const program = new Command()
    .name("dev-dashboard")
    .description("Personal dev dashboard (ttyd, cmux, obsidian) at mac.foltyn.dev")
    .version("0.1.0");

async function launchUI(): Promise<void> {
    const uiDir = resolve(import.meta.dirname, "ui");
    const configPath = resolve(uiDir, "vite.config.ts");
    if (!existsSync(configPath)) {
        logger.error({ configPath }, "vite.config.ts missing — scaffold incomplete");
        process.exit(1);
    }
    const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
    const { port } = await getConfig();
    const child = spawn("bun", [viteEntry, "--config", configPath, "--strictPort", "--port", String(port)], {
        cwd: uiDir,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "1" },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
}

program.action(launchUI);
program.command("ui").alias("dashboard").description("(default) Launch the dev-dashboard web UI").action(launchUI);

program.parseAsync().catch((err) => {
    logger.error({ err }, "dev-dashboard failed");
    process.exit(1);
});
```

- [ ] **Step 4: Write `src/dev-dashboard/README.md`**

```markdown
# dev-dashboard

Personal web dashboard for terminals (ttyd), cmux session viewing, and Obsidian note sharing. Runs at `http://localhost:3042`; exposed at `https://mac.foltyn.dev` via the existing Cloudflare Tunnel (Access-gated except `/share/*`).

## Run

```bash
tools dev-dashboard
```

Config stored at `~/.genesis-tools/dev-dashboard/config.json`.
```

- [ ] **Step 5: Sanity-check the entry point parses**

Run: `bun src/dev-dashboard/index.ts --help`
Expected: shows commander help with `ui` / `dashboard` subcommands. Exits 0. (Launch will fail because `ui/vite.config.ts` doesn't exist yet — that's fine, we'll add it in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/dev-dashboard/index.ts src/dev-dashboard/config.ts src/dev-dashboard/README.md
git commit -m "feat(dev-dashboard): scaffold tool entry + Zod-backed config"
```

---

## Task 2: Scaffold the Vite + TanStack Router UI shell

**Files:**
- Create: `src/dev-dashboard/ui/index.html`
- Create: `src/dev-dashboard/ui/package.json`
- Create: `src/dev-dashboard/ui/tsconfig.json`
- Create: `src/dev-dashboard/ui/biome.json`
- Create: `src/dev-dashboard/ui/vite.config.ts`
- Create: `src/dev-dashboard/ui/src/main.tsx`
- Create: `src/dev-dashboard/ui/src/router.tsx`
- Create: `src/dev-dashboard/ui/src/styles.css`
- Create: `src/dev-dashboard/ui/src/routes/__root.tsx`
- Create: `src/dev-dashboard/ui/src/routes/index.tsx`

- [ ] **Step 1: `src/dev-dashboard/ui/index.html`**

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>dev-dashboard</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: `src/dev-dashboard/ui/package.json` (minimal — deps live at repo root)**

```json
{
    "name": "dev-dashboard-ui",
    "private": true,
    "type": "module"
}
```

- [ ] **Step 3: `src/dev-dashboard/ui/tsconfig.json` (mirrors `src/claude-history-dashboard/tsconfig.json`)**

```json
{
    "include": ["**/*.ts", "**/*.tsx"],
    "exclude": ["node_modules", "vite.config.ts"],
    "compilerOptions": {
        "target": "ES2022",
        "jsx": "react-jsx",
        "module": "ESNext",
        "lib": ["ES2022", "DOM", "DOM.Iterable"],
        "types": ["vite/client", "bun"],
        "moduleResolution": "bundler",
        "allowImportingTsExtensions": true,
        "verbatimModuleSyntax": false,
        "noEmit": true,
        "skipLibCheck": true,
        "strict": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "noFallthroughCasesInSwitch": true,
        "noUncheckedSideEffectImports": true,
        "paths": {
            "@/*": ["./src/*"],
            "@app/*": ["../*"],
            "@ui/*": ["../utils/ui/*"],
            "@ui": ["../utils/ui/index.ts"]
        }
    }
}
```

- [ ] **Step 4: `src/dev-dashboard/ui/biome.json` (extends repo root)**

```json
{
    "$schema": "https://biomejs.dev/schemas/2.3.12/schema.json",
    "extends": ["../../../biome.json"]
}
```

- [ ] **Step 5: `src/dev-dashboard/ui/vite.config.ts`**

```ts
import { resolve } from "node:path";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";
import { attachDevDashboardMiddleware } from "./vite-middleware";

const config = createDashboardViteConfig({
    root: __dirname,
    port: 3042,
    aliases: {
        "@app": resolve(__dirname, "../.."),
    },
    reactOptions: {
        babel: {
            plugins: ["babel-plugin-react-compiler"],
        },
    },
});

// Attach our /api/* and /share/:slug middleware to whatever Vite dev server runs
config.plugins = [
    ...(config.plugins ?? []),
    {
        name: "dev-dashboard-middleware",
        configureServer(server) {
            attachDevDashboardMiddleware(server.middlewares);
        },
    },
];

export default config;
```

- [ ] **Step 6: `src/dev-dashboard/ui/vite-middleware.ts` (placeholder — fills in across Tasks 4/6/9)**

```ts
import type { Connect } from "vite";

// Each Task that adds backend endpoints appends a handler here.
// Order: more-specific paths first.
export function attachDevDashboardMiddleware(middlewares: Connect.Server): void {
    middlewares.use((req, res, next) => {
        // Tasks 4, 6, 9 will replace this stub with concrete /api/* and /share/:slug handlers.
        next();
    });
}
```

- [ ] **Step 7: `src/dev-dashboard/ui/src/main.tsx`**

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { getRouter } from "./router";

const router = getRouter();
const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <StrictMode>
            <RouterProvider router={router} />
        </StrictMode>
    );
}
```

- [ ] **Step 8: `src/dev-dashboard/ui/src/router.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "./routes/__root";
import { IndexRoute } from "./routes/index";

const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } },
});

const rootRoute = createRootRoute({
    component: () => (
        <QueryClientProvider client={queryClient}>
            <Shell>
                <Outlet />
            </Shell>
        </QueryClientProvider>
    ),
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: IndexRoute });

// Tasks 5, 8, 11, 12 add /ttyd, /cmux, /obsidian, /share/$slug routes here.
const routeTree = rootRoute.addChildren([indexRoute]);

export function getRouter() {
    return createRouter({ routeTree, defaultPreload: "intent" });
}
```

- [ ] **Step 9: `src/dev-dashboard/ui/src/styles.css` (tailwind + theme + slate-grid)**

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import '@ui/theme/styles.css';
@source "../../../utils/ui";
@import './slate-grid.css';

@custom-variant dark (&:is(.dark *));

body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing: antialiased;
    background: var(--dd-bg-base);
    color: var(--dd-text-primary);
    margin: 0;
    min-height: 100vh;
}

code, pre, .font-mono {
    font-family: 'JetBrains Mono', source-code-pro, Menlo, Monaco, Consolas, monospace;
}
```

- [ ] **Step 10: `src/dev-dashboard/ui/src/slate-grid.css` (theme tokens from the spec)**

```css
:root {
    --dd-bg-base: #0c0e10;
    --dd-bg-panel: #101316;
    --dd-border: #1e2428;
    --dd-grid: rgba(52, 211, 153, 0.04);
    --dd-accent-from: #34d399;
    --dd-accent-to: #2dd4bf;
    --dd-accent-gradient: linear-gradient(135deg, var(--dd-accent-from), var(--dd-accent-to));
    --dd-text-primary: #e6edf3;
    --dd-text-secondary: #8b96a0;
    --dd-text-muted: #5b6670;
}

.dd-grid-bg {
    background-image:
        linear-gradient(var(--dd-grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--dd-grid) 1px, transparent 1px);
    background-size: 20px 20px;
}

.dd-panel {
    background: var(--dd-bg-panel);
    border: 1px solid var(--dd-border);
    border-radius: 8px;
}

.dd-accent-text {
    background: var(--dd-accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
}
```

- [ ] **Step 11: `src/dev-dashboard/ui/src/routes/__root.tsx` (Shell — Sidebar + main area)**

```tsx
import type { ReactNode } from "react";

interface ShellProps {
    children: ReactNode;
}

export function Shell({ children }: ShellProps) {
    return (
        <div className="dd-grid-bg flex min-h-screen">
            <aside className="w-[62px] border-r border-[var(--dd-border)] bg-[var(--dd-bg-panel)]">
                {/* Sidebar component added in Task 3 */}
            </aside>
            <main className="flex-1 p-4">{children}</main>
        </div>
    );
}
```

- [ ] **Step 12: `src/dev-dashboard/ui/src/routes/index.tsx` (placeholder default route)**

```tsx
export function IndexRoute() {
    return (
        <div className="font-mono text-[var(--dd-text-secondary)]">
            <h1 className="dd-accent-text text-2xl font-bold tracking-widest">DEV-DASHBOARD_</h1>
            <p className="mt-2">Pick a panel from the sidebar.</p>
        </div>
    );
}
```

- [ ] **Step 13: Verify the UI launches**

Run: `tools dev-dashboard`
Expected: Vite dev server starts on `http://localhost:3042`, log shows "VITE v… ready". Open the URL in a browser → see "DEV-DASHBOARD_" heading on the slate-grid background. Empty sidebar.

- [ ] **Step 14: Run typecheck**

Run: `bun run tsgo -p src/dev-dashboard/ui/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add src/dev-dashboard/ui
git commit -m "feat(dev-dashboard): UI shell — Vite + TanStack Router + slate-grid theme"
```

---

## Task 3: Sidebar component

**Files:**
- Create: `src/dev-dashboard/ui/src/components/Sidebar.tsx`
- Modify: `src/dev-dashboard/ui/src/routes/__root.tsx`

- [ ] **Step 1: `src/dev-dashboard/ui/src/components/Sidebar.tsx`**

```tsx
import { Link, useLocation } from "@tanstack/react-router";
import { TerminalSquare, Boxes, BookOpen } from "lucide-react";
import type { ComponentType } from "react";

interface Item {
    to: string;
    label: string;
    Icon: ComponentType<{ size?: number }>;
}

const ITEMS: Item[] = [
    { to: "/ttyd", label: "ttyd", Icon: TerminalSquare },
    { to: "/cmux", label: "cmux", Icon: Boxes },
    { to: "/obsidian", label: "obsidian", Icon: BookOpen },
];

export function Sidebar() {
    const { pathname } = useLocation();
    return (
        <nav className="flex flex-col items-center gap-3 pt-4">
            <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px]"
                style={{ background: "var(--dd-accent-gradient)", boxShadow: "0 0 14px rgba(52,211,153,0.35)" }}
                aria-label="dev-dashboard"
            />
            {ITEMS.map(({ to, label, Icon }) => {
                const active = pathname.startsWith(to);
                return (
                    <Link
                        key={to}
                        to={to}
                        title={label}
                        className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] border transition"
                        style={{
                            background: active ? "var(--dd-accent-gradient)" : "transparent",
                            borderColor: active ? "transparent" : "var(--dd-border)",
                            color: active ? "#0c0e10" : "var(--dd-text-secondary)",
                        }}
                    >
                        <Icon size={14} />
                    </Link>
                );
            })}
        </nav>
    );
}
```

- [ ] **Step 2: Wire `<Sidebar />` into `__root.tsx`**

Replace the empty `<aside>` block with:

```tsx
import { Sidebar } from "../components/Sidebar";

// inside Shell:
<aside className="w-[62px] border-r border-[var(--dd-border)] bg-[var(--dd-bg-panel)]">
    <Sidebar />
</aside>
```

- [ ] **Step 3: Verify**

Run: `tools dev-dashboard` (if not already running — Vite hot-reloads).
Open `http://localhost:3042` → three icon buttons visible in the sidebar (ttyd, cmux, obsidian). Clicking shows `Not Found` for now (those routes added later) — that's expected.

- [ ] **Step 4: Commit**

```bash
git add src/dev-dashboard/ui/src/components/Sidebar.tsx src/dev-dashboard/ui/src/routes/__root.tsx
git commit -m "feat(dev-dashboard): sidebar with active-state gradient"
```

---

## Task 4: ttyd library — types, free-port helper, manager (TDD)

**Files:**
- Create: `src/dev-dashboard/lib/ttyd/types.ts`
- Create: `src/dev-dashboard/lib/ttyd/free-port.ts`
- Create: `src/dev-dashboard/lib/ttyd/manager.ts`
- Create: `src/dev-dashboard/lib/ttyd/manager.test.ts`

- [ ] **Step 1: `src/dev-dashboard/lib/ttyd/types.ts`**

```ts
export interface TtydSession {
    id: string;
    port: number;
    command: string;
    cwd: string;
    pid: number;
    startedAt: string; // ISO
}

export type SplitNode =
    | { kind: "leaf"; sessionId: string }
    | { kind: "split"; direction: "row" | "column"; ratio: number; children: [SplitNode, SplitNode] };
```

- [ ] **Step 2: `src/dev-dashboard/lib/ttyd/free-port.ts`**

```ts
import { createServer } from "node:net";

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (typeof addr === "object" && addr) {
                const port = addr.port;
                srv.close(() => resolve(port));
            } else {
                srv.close(() => reject(new Error("no address from free-port probe")));
            }
        });
    });
}
```

- [ ] **Step 3: Write the failing test `src/dev-dashboard/lib/ttyd/manager.test.ts`**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { killAllTtyd, killTtyd, listTtyd, spawnTtyd } from "./manager";

describe("ttyd manager", () => {
    afterEach(async () => {
        await killAllTtyd();
    });

    test("spawn registers a session with a unique port", async () => {
        const a = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const b = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        expect(a.id).not.toBe(b.id);
        expect(a.port).not.toBe(b.port);
        expect(a.pid).toBeGreaterThan(0);
        expect(listTtyd()).toHaveLength(2);
    });

    test("kill removes from registry and terminates process", async () => {
        const s = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const ok = await killTtyd(s.id);
        expect(ok).toBe(true);
        expect(listTtyd()).toHaveLength(0);
    });

    test("killTtyd on unknown id returns false", async () => {
        const ok = await killTtyd("nope");
        expect(ok).toBe(false);
    });
});
```

- [ ] **Step 4: Run the test to verify it fails (no manager.ts yet)**

Run: `bun test src/dev-dashboard/lib/ttyd/manager.test.ts`
Expected: FAIL — `Cannot find module './manager'`.

- [ ] **Step 5: Implement `src/dev-dashboard/lib/ttyd/manager.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import logger from "@app/logger";
import { findFreePort } from "./free-port";
import type { TtydSession } from "./types";

interface Tracked {
    session: TtydSession;
    child: ChildProcess;
}

const registry = new Map<string, Tracked>();
const TTYD_BIN = "/opt/homebrew/bin/ttyd";

export interface SpawnOptions {
    command?: string;
    cwd?: string;
}

export async function spawnTtyd(opts: SpawnOptions = {}): Promise<TtydSession> {
    const command = opts.command ?? process.env.SHELL ?? "/bin/zsh";
    const cwd = opts.cwd ?? process.cwd();
    const port = await findFreePort();
    const id = randomUUID();

    // -W = writable, -p = port, then the program to run inside the terminal.
    const child = spawn(TTYD_BIN, ["-W", "-p", String(port), command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err) => logger.error({ err, id, port }, "ttyd child error"));
    child.on("exit", (code, signal) => {
        logger.debug({ id, port, code, signal }, "ttyd child exited");
        registry.delete(id);
    });

    const session: TtydSession = {
        id,
        port,
        command,
        cwd,
        pid: child.pid ?? -1,
        startedAt: new Date().toISOString(),
    };
    registry.set(id, { session, child });
    logger.info({ id, port, command, cwd }, "ttyd spawned");
    return session;
}

export function listTtyd(): TtydSession[] {
    return Array.from(registry.values()).map((t) => t.session);
}

export async function killTtyd(id: string): Promise<boolean> {
    const tracked = registry.get(id);
    if (!tracked) {
        return false;
    }

    tracked.child.kill("SIGTERM");
    registry.delete(id);
    return true;
}

export async function killAllTtyd(): Promise<void> {
    for (const { child } of registry.values()) {
        child.kill("SIGTERM");
    }
    registry.clear();
}

// Ensure all children die when the dashboard process does.
process.on("exit", () => {
    for (const { child } of registry.values()) {
        try {
            child.kill("SIGTERM");
        } catch {
            // ignore
        }
    }
});
```

- [ ] **Step 6: Run the tests again — they should pass**

Run: `bun test src/dev-dashboard/lib/ttyd/manager.test.ts`
Expected: PASS — 3 tests pass. (Note: these spawn real `ttyd` processes; ensure `/opt/homebrew/bin/ttyd` exists with `which ttyd` first.)

- [ ] **Step 7: Commit**

```bash
git add src/dev-dashboard/lib/ttyd
git commit -m "feat(dev-dashboard): ttyd manager — spawn/list/kill with free-port helper (TDD)"
```

---

## Task 5: ttyd HTTP API (Vite middleware) + ttyd route + tabs UI

**Files:**
- Modify: `src/dev-dashboard/ui/vite-middleware.ts`
- Create: `src/dev-dashboard/ui/src/lib/api.ts`
- Create: `src/dev-dashboard/ui/src/routes/ttyd.tsx`
- Create: `src/dev-dashboard/ui/src/components/TtydPane.tsx`
- Modify: `src/dev-dashboard/ui/src/router.tsx` (add `/ttyd` route)

- [ ] **Step 1: Replace `src/dev-dashboard/ui/vite-middleware.ts` with the ttyd handlers**

```ts
import type { Connect } from "vite";
import { SafeJSON } from "@app/utils/json";
import { killTtyd, listTtyd, spawnTtyd } from "../lib/ttyd/manager";

async function readJson<T>(req: Connect.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    return SafeJSON.parse(raw) as T;
}

function send(res: Connect.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(SafeJSON.stringify(body));
}

export function attachDevDashboardMiddleware(middlewares: Connect.Server): void {
    middlewares.use("/api/ttyd/list", (req, res, next) => {
        if (req.method !== "GET") {
            return next();
        }

        send(res, 200, { sessions: listTtyd() });
    });

    middlewares.use("/api/ttyd/spawn", async (req, res, next) => {
        if (req.method !== "POST") {
            return next();
        }

        try {
            const body = await readJson<{ command?: string; cwd?: string }>(req);
            const session = await spawnTtyd(body);
            send(res, 200, { session });
        } catch (err) {
            send(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    middlewares.use("/api/ttyd/kill", async (req, res, next) => {
        if (req.method !== "POST") {
            return next();
        }

        try {
            const body = await readJson<{ id: string }>(req);
            const ok = await killTtyd(body.id);
            send(res, 200, { ok });
        } catch (err) {
            send(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });
}
```

- [ ] **Step 2: `src/dev-dashboard/ui/src/lib/api.ts` (client-side fetch wrappers)**

```ts
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${url} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
}

export const ttydApi = {
    list: () => jsonFetch<{ sessions: TtydSession[] }>("/api/ttyd/list"),
    spawn: (body: { command?: string; cwd?: string } = {}) =>
        jsonFetch<{ session: TtydSession }>("/api/ttyd/spawn", { method: "POST", body: JSON.stringify(body) }),
    kill: (id: string) => jsonFetch<{ ok: boolean }>("/api/ttyd/kill", { method: "POST", body: JSON.stringify({ id }) }),
};
```

(Note: `SafeJSON` is a server-side requirement; client-side `JSON` is fine because browsers don't have biome.)

- [ ] **Step 3: `src/dev-dashboard/ui/src/components/TtydPane.tsx` (single-session iframe leaf)**

```tsx
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

interface Props {
    session: TtydSession;
}

export function TtydPane({ session }: Props) {
    return (
        <div className="dd-panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--dd-border)] px-2 py-1 text-[10px] text-[var(--dd-text-secondary)]">
                <span className="font-mono">▸ ttyd · {session.command}</span>
                <span className="font-mono text-[var(--dd-text-muted)]">:{session.port}</span>
            </div>
            <iframe
                src={`http://localhost:${session.port}`}
                title={`ttyd-${session.id}`}
                className="flex-1 border-0 bg-black"
            />
        </div>
    );
}
```

- [ ] **Step 4: `src/dev-dashboard/ui/src/routes/ttyd.tsx` (tabs of sessions)**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@ui/components/button";
import { TtydPane } from "../components/TtydPane";
import { ttydApi } from "../lib/api";

export function TtydRoute() {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ["ttyd", "list"], queryFn: ttydApi.list });
    const sessions = data?.sessions ?? [];
    const [activeId, setActiveId] = useState<string | null>(null);

    const spawn = useMutation({
        mutationFn: () => ttydApi.spawn(),
        onSuccess: ({ session }) => {
            qc.invalidateQueries({ queryKey: ["ttyd", "list"] });
            setActiveId(session.id);
        },
    });

    const kill = useMutation({
        mutationFn: (id: string) => ttydApi.kill(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["ttyd", "list"] });
            setActiveId((current) => (current && sessions.find((s) => s.id === current) ? current : null));
        },
    });

    const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-2">
            <div className="flex items-center gap-1 overflow-x-auto">
                {sessions.map((s) => {
                    const isActive = s.id === active?.id;
                    return (
                        <div
                            key={s.id}
                            className="flex items-center gap-1 rounded-md border border-[var(--dd-border)] px-2 py-1 font-mono text-[11px]"
                            style={isActive ? { background: "var(--dd-accent-gradient)", color: "#0c0e10" } : undefined}
                        >
                            <button type="button" onClick={() => setActiveId(s.id)}>
                                {s.command.split("/").pop()} :{s.port}
                            </button>
                            <button type="button" onClick={() => kill.mutate(s.id)} aria-label="close">
                                <X size={11} />
                            </button>
                        </div>
                    );
                })}
                <Button size="sm" variant="outline" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
                    <Plus size={14} /> New terminal
                </Button>
            </div>
            <div className="flex-1 overflow-hidden">
                {active ? (
                    <TtydPane session={active} />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No terminals — click "New terminal".
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 5: Register the `/ttyd` route in `router.tsx`**

Add to the imports:

```tsx
import { TtydRoute } from "./routes/ttyd";
```

Add the route definition before `routeTree = rootRoute.addChildren(...)`:

```tsx
const ttydRoute = createRoute({ getParentRoute: () => rootRoute, path: "/ttyd", component: TtydRoute });
```

And include it in `addChildren`:

```tsx
const routeTree = rootRoute.addChildren([indexRoute, ttydRoute]);
```

- [ ] **Step 6: Run the app and verify**

Run: `tools dev-dashboard` (or refresh if already running).
Open `http://localhost:3042/ttyd` → empty state. Click **New terminal** → a tab appears with a working shell iframe. Click the **×** on the tab → tab disappears.

- [ ] **Step 7: Commit**

```bash
git add src/dev-dashboard/ui/vite-middleware.ts src/dev-dashboard/ui/src/lib/api.ts src/dev-dashboard/ui/src/components/TtydPane.tsx src/dev-dashboard/ui/src/routes/ttyd.tsx src/dev-dashboard/ui/src/router.tsx
git commit -m "feat(dev-dashboard): /ttyd panel — tab-based session manager"
```

---

## Task 6: ttyd split panes (react-mosaic-component)

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/dev-dashboard/ui/src/routes/ttyd.tsx` — replace tab-only layout with mosaic.

- [ ] **Step 1: Install dependency**

```bash
bun add react-mosaic-component @types/react-mosaic-component
```

- [ ] **Step 2: Verify it resolves**

Run: `bun pm ls | rg react-mosaic-component`
Expected: prints the version.

- [ ] **Step 3: Replace `src/dev-dashboard/ui/src/routes/ttyd.tsx` with the mosaic-backed version**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { Button } from "@ui/components/button";
import { TtydPane } from "../components/TtydPane";
import { ttydApi } from "../lib/api";

export function TtydRoute() {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ["ttyd", "list"], queryFn: ttydApi.list });
    const sessions = data?.sessions ?? [];
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);

    const spawn = useMutation({
        mutationFn: () => ttydApi.spawn(),
        onSuccess: ({ session }) => {
            qc.invalidateQueries({ queryKey: ["ttyd", "list"] });
            // Add the new session as a right-split of the current layout, or as the sole leaf.
            setLayout((current) =>
                current ? { direction: "row", first: current, second: session.id, splitPercentage: 60 } : session.id
            );
        },
    });

    const kill = useMutation({
        mutationFn: (id: string) => ttydApi.kill(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["ttyd", "list"] }),
    });

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-2">
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
                    <Plus size={14} /> New terminal
                </Button>
                <span className="text-[11px] font-mono text-[var(--dd-text-muted)]">
                    drag dividers to resize · close a window to kill the session
                </span>
            </div>
            <div className="flex-1 overflow-hidden">
                {layout && sessions.length > 0 ? (
                    <Mosaic<string>
                        value={layout}
                        onChange={(next) => setLayout(next)}
                        renderTile={(id, path) => {
                            const session = sessions.find((s) => s.id === id);
                            if (!session) {
                                return <div className="dd-panel p-2 text-[var(--dd-text-muted)]">session gone</div>;
                            }
                            return (
                                <MosaicWindow<string>
                                    path={path}
                                    title={`${session.command.split("/").pop()} :${session.port}`}
                                    onDragEnd={() => {
                                        /* mosaic handles */
                                    }}
                                    additionalControls={[]}
                                    toolbarControls={[
                                        <button
                                            type="button"
                                            key="close"
                                            className="px-2 text-xs text-[var(--dd-text-secondary)]"
                                            onClick={() => kill.mutate(session.id)}
                                            aria-label="close"
                                        >
                                            ×
                                        </button>,
                                    ]}
                                >
                                    <TtydPane session={session} />
                                </MosaicWindow>
                            );
                        }}
                        className="dd-mosaic"
                    />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No terminals — click "New terminal".
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Add minimal mosaic theming (override the default light blueprint look)**

Append to `src/dev-dashboard/ui/src/slate-grid.css`:

```css
.dd-mosaic .mosaic-window {
    background: var(--dd-bg-panel);
    border: 1px solid var(--dd-border);
}
.dd-mosaic .mosaic-window-toolbar {
    background: var(--dd-bg-panel);
    color: var(--dd-text-secondary);
    border-bottom: 1px solid var(--dd-border);
}
.dd-mosaic .mosaic-split {
    background: var(--dd-border);
}
.dd-mosaic .mosaic-split:hover {
    background: var(--dd-accent-from);
}
```

- [ ] **Step 5: Verify split-pane behaviour**

Run / refresh `tools dev-dashboard`. On `/ttyd`:
1. Click **New terminal** — single pane appears.
2. Click again — second terminal opens to the right (60/40 split).
3. Drag the divider — both shells resize live.
4. Click **×** on either toolbar — that session is killed and pane closes.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/dev-dashboard/ui/src/routes/ttyd.tsx src/dev-dashboard/ui/src/slate-grid.css
git commit -m "feat(dev-dashboard): ttyd split panes via react-mosaic-component"
```

---

## Task 7: cmux library — client wrapper, poller, types (TDD)

**Files:**
- Create: `src/dev-dashboard/lib/cmux/types.ts`
- Create: `src/dev-dashboard/lib/cmux/client.ts`
- Create: `src/dev-dashboard/lib/cmux/client.test.ts`
- Create: `src/dev-dashboard/lib/cmux/poller.ts`

- [ ] **Step 1: `src/dev-dashboard/lib/cmux/types.ts`**

```ts
export interface CmuxWorkspace {
    id: string;
    name: string;
}

export interface CmuxPane {
    id: string;
    workspaceId: string;
    title: string;
    active: boolean;
    cwd?: string;
}

export interface CmuxSnapshot {
    fetchedAt: string;
    available: boolean;
    error?: string;
    workspaces: CmuxWorkspace[];
    panes: CmuxPane[];
}
```

- [ ] **Step 2: Write the failing test `src/dev-dashboard/lib/cmux/client.test.ts`**

```ts
import { describe, expect, mock, test } from "bun:test";
import { fetchSnapshot } from "./client";

describe("cmux client", () => {
    test("fetchSnapshot returns available=false when rpc throws", async () => {
        const rpc = mock(async () => {
            throw new Error("cmux not running");
        });
        const snap = await fetchSnapshot({ rpc });
        expect(snap.available).toBe(false);
        expect(snap.error).toContain("cmux not running");
        expect(snap.workspaces).toEqual([]);
        expect(snap.panes).toEqual([]);
    });

    test("fetchSnapshot maps workspace.list + pane.list", async () => {
        const rpc = mock(async (method: string) => {
            if (method === "workspace.list") {
                return { workspaces: [{ id: "workspace:1", name: "main" }] };
            }
            if (method === "pane.list") {
                return {
                    panes: [
                        { id: "pane:1", workspace: "workspace:1", title: "zsh", selected: true, cwd: "/tmp" },
                    ],
                };
            }
            throw new Error(`unexpected method ${method}`);
        });
        const snap = await fetchSnapshot({ rpc });
        expect(snap.available).toBe(true);
        expect(snap.workspaces).toEqual([{ id: "workspace:1", name: "main" }]);
        expect(snap.panes[0]).toEqual({
            id: "pane:1",
            workspaceId: "workspace:1",
            title: "zsh",
            active: true,
            cwd: "/tmp",
        });
    });
});
```

- [ ] **Step 3: Run the test — should fail**

Run: `bun test src/dev-dashboard/lib/cmux/client.test.ts`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 4: Implement `src/dev-dashboard/lib/cmux/client.ts`**

```ts
import { rpc as defaultRpc } from "@app/cmux/lib/socket";
import logger from "@app/logger";
import type { CmuxPane, CmuxSnapshot, CmuxWorkspace } from "./types";

interface WorkspaceListRpc {
    workspaces: Array<{ id: string; name?: string }>;
}

interface PaneListRpc {
    panes: Array<{ id: string; workspace: string; title?: string; selected?: boolean; cwd?: string }>;
}

interface Deps {
    // Injectable for tests; defaults to the real cmux socket rpc.
    rpc?: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export async function fetchSnapshot(deps: Deps = {}): Promise<CmuxSnapshot> {
    const rpcFn = deps.rpc ?? defaultRpc;
    const fetchedAt = new Date().toISOString();
    try {
        const wsRes = await rpcFn<WorkspaceListRpc>("workspace.list");
        const workspaces: CmuxWorkspace[] = wsRes.workspaces.map((w) => ({
            id: w.id,
            name: w.name ?? w.id,
        }));

        const allPanes: CmuxPane[] = [];
        for (const ws of workspaces) {
            const paneRes = await rpcFn<PaneListRpc>("pane.list", { workspace: ws.id });
            for (const p of paneRes.panes) {
                allPanes.push({
                    id: p.id,
                    workspaceId: p.workspace,
                    title: p.title ?? p.id,
                    active: p.selected === true,
                    cwd: p.cwd,
                });
            }
        }
        return { fetchedAt, available: true, workspaces, panes: allPanes };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "cmux snapshot failed");
        return { fetchedAt, available: false, error: message, workspaces: [], panes: [] };
    }
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `bun test src/dev-dashboard/lib/cmux/client.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 6: Implement `src/dev-dashboard/lib/cmux/poller.ts` (cached + interval-driven)**

```ts
import logger from "@app/logger";
import { fetchSnapshot } from "./client";
import type { CmuxSnapshot } from "./types";

let cached: CmuxSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getCachedSnapshot(): CmuxSnapshot {
    if (cached) {
        return cached;
    }

    return { fetchedAt: new Date().toISOString(), available: false, workspaces: [], panes: [] };
}

export async function refreshOnce(): Promise<CmuxSnapshot> {
    cached = await fetchSnapshot();
    return cached;
}

export function startPolling(intervalMs: number): void {
    if (timer) {
        return;
    }

    timer = setInterval(() => {
        refreshOnce().catch((err) => logger.debug({ err }, "cmux poll failed"));
    }, intervalMs);
    // Kick off immediately.
    refreshOnce().catch(() => {
        /* ignored — fetchSnapshot already logs and returns unavailable */
    });
}

export function stopPolling(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/dev-dashboard/lib/cmux
git commit -m "feat(dev-dashboard): cmux client + poller (TDD; wraps existing rpc)"
```

---

## Task 8: cmux HTTP endpoint + /cmux UI

**Files:**
- Modify: `src/dev-dashboard/ui/vite-middleware.ts` — add `/api/cmux/snapshot`.
- Modify: `src/dev-dashboard/ui/src/lib/api.ts` — add `cmuxApi`.
- Create: `src/dev-dashboard/ui/src/components/CmuxSessionList.tsx`
- Create: `src/dev-dashboard/ui/src/routes/cmux.tsx`
- Modify: `src/dev-dashboard/ui/src/router.tsx` — register `/cmux`.

- [ ] **Step 1: Add the cmux middleware**

Append inside `attachDevDashboardMiddleware`:

```ts
import { getConfig } from "@app/dev-dashboard/config";
import { getCachedSnapshot, startPolling } from "@app/dev-dashboard/lib/cmux/poller";

// Boot the poller once at module load (Vite imports this file when the dev server starts).
getConfig().then(({ cmuxPollIntervalMs }) => startPolling(cmuxPollIntervalMs));

middlewares.use("/api/cmux/snapshot", (req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }

    send(res, 200, { snapshot: getCachedSnapshot() });
});
```

(Put the two imports at the top of the file with the other imports; the `getConfig().then(...)` line goes at module scope, not inside `attachDevDashboardMiddleware`.)

- [ ] **Step 2: Add `cmuxApi` to `src/dev-dashboard/ui/src/lib/api.ts`**

```ts
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";

export const cmuxApi = {
    snapshot: () => jsonFetch<{ snapshot: CmuxSnapshot }>("/api/cmux/snapshot"),
};
```

- [ ] **Step 3: `src/dev-dashboard/ui/src/components/CmuxSessionList.tsx`**

```tsx
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";

interface Props {
    snapshot: CmuxSnapshot;
}

export function CmuxSessionList({ snapshot }: Props) {
    if (!snapshot.available) {
        return (
            <div className="dd-panel flex h-full items-center justify-center font-mono text-[var(--dd-text-muted)]">
                <div className="text-center">
                    <p>cmux is not reachable.</p>
                    <p className="mt-1 text-[10px]">{snapshot.error ?? "Start the cmux app to populate this panel."}</p>
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col gap-2 overflow-auto font-mono">
            {snapshot.workspaces.map((ws) => {
                const panes = snapshot.panes.filter((p) => p.workspaceId === ws.id);
                return (
                    <section key={ws.id} className="dd-panel p-3">
                        <h3 className="dd-accent-text text-[12px] font-bold tracking-widest">▸ {ws.name}</h3>
                        <ul className="mt-2 space-y-1 text-[11px]">
                            {panes.map((p) => (
                                <li key={p.id} className="flex items-center gap-2">
                                    <span
                                        className="inline-block h-[6px] w-[6px] rounded-full"
                                        style={
                                            p.active
                                                ? {
                                                      background: "var(--dd-accent-from)",
                                                      boxShadow: "0 0 6px var(--dd-accent-from)",
                                                  }
                                                : { background: "#2a3439" }
                                        }
                                    />
                                    <span className="text-[var(--dd-text-secondary)]">{p.title}</span>
                                    {p.cwd ? <span className="text-[var(--dd-text-muted)]">— {p.cwd}</span> : null}
                                </li>
                            ))}
                            {panes.length === 0 ? (
                                <li className="text-[var(--dd-text-muted)]">(no panes)</li>
                            ) : null}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 4: `src/dev-dashboard/ui/src/routes/cmux.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { CmuxSessionList } from "../components/CmuxSessionList";
import { cmuxApi } from "../lib/api";

export function CmuxRoute() {
    const { data } = useQuery({
        queryKey: ["cmux", "snapshot"],
        queryFn: cmuxApi.snapshot,
        refetchInterval: 2000,
    });
    return (
        <div className="h-[calc(100vh-2rem)]">
            {data?.snapshot ? (
                <CmuxSessionList snapshot={data.snapshot} />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Loading cmux snapshot…
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 5: Register `/cmux` in `router.tsx`**

```tsx
import { CmuxRoute } from "./routes/cmux";
const cmuxRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cmux", component: CmuxRoute });
const routeTree = rootRoute.addChildren([indexRoute, ttydRoute, cmuxRoute]);
```

- [ ] **Step 6: Verify**

With cmux app running, open `http://localhost:3042/cmux` → list of workspaces and panes appears; active pane shows the glowing emerald dot; list refreshes every 2s. If cmux is NOT running, the panel shows the "cmux is not reachable" message — also acceptable.

- [ ] **Step 7: Commit**

```bash
git add src/dev-dashboard/ui/vite-middleware.ts src/dev-dashboard/ui/src/lib/api.ts src/dev-dashboard/ui/src/components/CmuxSessionList.tsx src/dev-dashboard/ui/src/routes/cmux.tsx src/dev-dashboard/ui/src/router.tsx
git commit -m "feat(dev-dashboard): /cmux panel — live snapshot every 2s"
```

---

## Task 9: cmux attach spike (timeboxed: 90 minutes max)

This is the explicit best-effort spike from the spec. **Stop after 90 minutes regardless of outcome** and either land the integration *or* commit a follow-up note in the panel UI saying "live view only — true attach not supported in cmux 0.63.2."

**Files:**
- Modify: `src/dev-dashboard/lib/cmux/client.ts` — add `capturePane(paneId)` if a usable RPC exists.
- Modify: `src/dev-dashboard/ui/src/components/CmuxSessionList.tsx` — wire an "Attach" button per pane.

- [ ] **Step 1: Inventory candidate RPCs**

Run: `(echo '{"id":"x","method":"capabilities","params":{}}'; sleep 0.2) | nc -U "$(cmux identify --json | jq -r .socket_path)" | head -c 2000`
Expected: prints a JSON list of method names — look for any of: `pane.attach`, `pane.stream`, `surface.stream`, `capture-pane`, `pane.capture`, `surface.attach`.

- [ ] **Step 2: Decide based on what exists**

If any of these methods exists and streams content → **path A: implement.**
If none → **path B: write the "no-attach" notice.**

- [ ] **Step 3a (path A only): Spawn a ttyd that pipes the stream**

Add to `src/dev-dashboard/lib/cmux/client.ts`:

```ts
export async function getAttachableCommand(paneId: string): Promise<string | null> {
    // Returns a shell command that, when run inside a ttyd, follows the pane's content.
    // Update once the actual streaming RPC is confirmed in Step 1.
    return null; // path A implementation goes here
}
```

Then in the `/api/cmux/attach` middleware (add to `vite-middleware.ts`), POST `{paneId}` → call `getAttachableCommand`, if non-null, `spawnTtyd({ command })` and return the resulting `TtydSession`.

UI: in `CmuxSessionList.tsx`, render an **"Attach"** button next to each pane; on click, POST `/api/cmux/attach` and navigate to `/ttyd` with that session active.

- [ ] **Step 3b (path B only): Document the limitation in the UI**

In `CmuxSessionList.tsx`, render a disabled "Attach" button with a tooltip:

```tsx
<button type="button" disabled className="text-[10px] text-[var(--dd-text-muted)] underline decoration-dotted" title="cmux 0.63.2 does not expose a streaming attach RPC; only live snapshots are supported.">
    attach (n/a)
</button>
```

- [ ] **Step 4: Commit (whichever path)**

If path A:
```bash
git commit -am "feat(dev-dashboard): cmux pane attach via ttyd-piped <RPC name>"
```

If path B:
```bash
git commit -am "docs(dev-dashboard): note that cmux attach is not supported (0.63.2)"
```

---

## Task 10: Obsidian library — reader, markdown renderer, publish (TDD)

**Files:**
- Create: `src/dev-dashboard/lib/obsidian/types.ts`
- Create: `src/dev-dashboard/lib/obsidian/reader.ts`
- Create: `src/dev-dashboard/lib/obsidian/markdown.ts`
- Create: `src/dev-dashboard/lib/obsidian/markdown.test.ts`
- Create: `src/dev-dashboard/lib/obsidian/publish.ts`
- Create: `src/dev-dashboard/lib/obsidian/publish.test.ts`

- [ ] **Step 1: `src/dev-dashboard/lib/obsidian/types.ts`**

```ts
export interface VaultEntry {
    name: string;
    relativePath: string;
    isDirectory: boolean;
    children?: VaultEntry[];
}

export interface PublishedNote {
    slug: string;
    vaultPath: string; // relative to vault root
    publishedAt: string; // ISO
}
```

- [ ] **Step 2: `src/dev-dashboard/lib/obsidian/reader.ts`**

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { VaultEntry } from "./types";

const EXCLUDED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export async function listVault(vaultRoot: string): Promise<VaultEntry[]> {
    async function walk(dir: string): Promise<VaultEntry[]> {
        const items = await readdir(dir, { withFileTypes: true });
        const out: VaultEntry[] = [];
        for (const item of items) {
            if (item.name.startsWith(".") && EXCLUDED_DIRS.has(item.name)) {
                continue;
            }

            if (EXCLUDED_DIRS.has(item.name)) {
                continue;
            }

            const full = join(dir, item.name);
            const rel = relative(vaultRoot, full);
            if (item.isDirectory()) {
                out.push({ name: item.name, relativePath: rel, isDirectory: true, children: await walk(full) });
            } else if (item.isFile() && item.name.endsWith(".md")) {
                out.push({ name: item.name, relativePath: rel, isDirectory: false });
            }
        }
        out.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }

            return a.name.localeCompare(b.name);
        });
        return out;
    }
    return walk(vaultRoot);
}

export async function readNote(vaultRoot: string, relativePath: string): Promise<string> {
    const full = join(vaultRoot, relativePath);
    const stats = await stat(full);
    if (!stats.isFile()) {
        throw new Error(`Not a file: ${relativePath}`);
    }
    return readFile(full, "utf8");
}
```

- [ ] **Step 3: Write the failing test `src/dev-dashboard/lib/obsidian/markdown.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
    test("renders basic markdown", () => {
        const html = renderMarkdown("# Hello\n\nWorld", { resolveWikilink: () => null });
        expect(html).toContain("<h1>");
        expect(html).toContain("Hello");
    });

    test("wikilink to unpublished note → plain styled text", () => {
        const html = renderMarkdown("see [[Other Note]] here", { resolveWikilink: () => null });
        expect(html).toContain("Other Note");
        expect(html).not.toContain("href=");
    });

    test("wikilink to published note → link to /share/<slug>", () => {
        const html = renderMarkdown("see [[Other Note]] here", {
            resolveWikilink: (name) => (name === "Other Note" ? "abc123" : null),
        });
        expect(html).toContain('href="/share/abc123"');
        expect(html).toContain(">Other Note</a>");
    });
});
```

- [ ] **Step 4: Run test — should fail**

Run: `bun test src/dev-dashboard/lib/obsidian/markdown.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 5: Implement `src/dev-dashboard/lib/obsidian/markdown.ts`**

```ts
import { marked } from "marked";

interface RenderOptions {
    resolveWikilink: (name: string) => string | null; // returns slug if published, else null
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function renderMarkdown(source: string, opts: RenderOptions): string {
    const preprocessed = source.replace(WIKILINK_RE, (_match, name: string, alias?: string) => {
        const trimmed = name.trim();
        const display = alias?.trim() ?? trimmed;
        const slug = opts.resolveWikilink(trimmed);
        if (slug) {
            return `<a href="/share/${slug}" class="dd-wikilink">${display}</a>`;
        }
        return `<span class="dd-wikilink dd-wikilink-unresolved">${display}</span>`;
    });
    return marked.parse(preprocessed, { async: false }) as string;
}
```

- [ ] **Step 6: Run tests — should pass**

Run: `bun test src/dev-dashboard/lib/obsidian/markdown.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 7: Write the failing test `src/dev-dashboard/lib/obsidian/publish.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "@app/utils/storage/storage";
import { rmSync, existsSync } from "node:fs";
import { findPublishedBySlug, findPublishedByPath, publishNote, unpublishNote } from "./publish";

const storage = new Storage("dev-dashboard");

describe("obsidian publish registry", () => {
    beforeEach(async () => {
        await storage.setConfig({ port: 3042, obsidianVault: "/x", publishedNotes: [], cmuxPollIntervalMs: 2000 });
    });
    afterEach(() => {
        if (existsSync(storage.getConfigPath())) {
            rmSync(storage.getConfigPath());
        }
    });

    test("publishNote stores a unique slug + round-trip lookup", async () => {
        const note = await publishNote("Folder/Foo.md");
        expect(note.slug.length).toBeGreaterThan(8);
        const found = await findPublishedBySlug(note.slug);
        expect(found?.vaultPath).toBe("Folder/Foo.md");
    });

    test("publishing the same path twice returns the existing entry (idempotent)", async () => {
        const a = await publishNote("X.md");
        const b = await publishNote("X.md");
        expect(a.slug).toBe(b.slug);
    });

    test("unpublishNote removes the entry", async () => {
        const note = await publishNote("Y.md");
        await unpublishNote(note.slug);
        const found = await findPublishedBySlug(note.slug);
        expect(found).toBeUndefined();
    });

    test("findPublishedByPath reverse-lookup", async () => {
        const note = await publishNote("Z.md");
        const found = await findPublishedByPath("Z.md");
        expect(found?.slug).toBe(note.slug);
    });
});
```

- [ ] **Step 8: Run test — should fail**

Run: `bun test src/dev-dashboard/lib/obsidian/publish.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 9: Implement `src/dev-dashboard/lib/obsidian/publish.ts`**

```ts
import { randomBytes } from "node:crypto";
import { getConfig, saveConfig, type PublishedNote } from "../../config";

function makeSlug(): string {
    return randomBytes(12).toString("base64url");
}

export async function publishNote(vaultPath: string): Promise<PublishedNote> {
    const config = await getConfig();
    const existing = config.publishedNotes.find((n) => n.vaultPath === vaultPath);
    if (existing) {
        return existing;
    }

    const note: PublishedNote = {
        slug: makeSlug(),
        vaultPath,
        publishedAt: new Date().toISOString(),
    };
    await saveConfig({ ...config, publishedNotes: [...config.publishedNotes, note] });
    return note;
}

export async function unpublishNote(slug: string): Promise<void> {
    const config = await getConfig();
    await saveConfig({ ...config, publishedNotes: config.publishedNotes.filter((n) => n.slug !== slug) });
}

export async function findPublishedBySlug(slug: string): Promise<PublishedNote | undefined> {
    const config = await getConfig();
    return config.publishedNotes.find((n) => n.slug === slug);
}

export async function findPublishedByPath(vaultPath: string): Promise<PublishedNote | undefined> {
    const config = await getConfig();
    return config.publishedNotes.find((n) => n.vaultPath === vaultPath);
}

export async function listPublished(): Promise<PublishedNote[]> {
    const config = await getConfig();
    return config.publishedNotes;
}
```

- [ ] **Step 10: Run all obsidian tests — should pass**

Run: `bun test src/dev-dashboard/lib/obsidian/`
Expected: PASS — markdown + publish tests all green.

- [ ] **Step 11: Commit**

```bash
git add src/dev-dashboard/lib/obsidian
git commit -m "feat(dev-dashboard): obsidian lib — vault reader, markdown w/ wikilinks, publish registry (TDD)"
```

---

## Task 11: Obsidian HTTP endpoints + /obsidian UI

**Files:**
- Modify: `src/dev-dashboard/ui/vite-middleware.ts` — add `/api/obsidian/*` endpoints.
- Modify: `src/dev-dashboard/ui/src/lib/api.ts` — add `obsidianApi`.
- Create: `src/dev-dashboard/ui/src/components/ObsidianTree.tsx`
- Create: `src/dev-dashboard/ui/src/components/ObsidianReader.tsx`
- Create: `src/dev-dashboard/ui/src/routes/obsidian.tsx`
- Modify: `src/dev-dashboard/ui/src/router.tsx` — register `/obsidian`.

- [ ] **Step 1: Add obsidian middleware**

Add to `vite-middleware.ts`:

```ts
import { listVault, readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { findPublishedByPath, listPublished, publishNote, unpublishNote } from "@app/dev-dashboard/lib/obsidian/publish";

middlewares.use("/api/obsidian/tree", async (req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }

    const { obsidianVault } = await getConfig();
    try {
        const entries = await listVault(obsidianVault);
        send(res, 200, { entries });
    } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
});

middlewares.use("/api/obsidian/note", async (req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }

    const url = new URL(req.url ?? "/", "http://x");
    const path = url.searchParams.get("path");
    if (!path) {
        return send(res, 400, { error: "missing ?path=" });
    }
    const { obsidianVault } = await getConfig();
    try {
        const source = await readNote(obsidianVault, path);
        const published = await listPublished();
        const slugMap = new Map(published.map((n) => [n.vaultPath, n.slug]));
        // Heuristic: wikilink "Foo" matches a file whose basename (sans .md) equals "Foo".
        const html = renderMarkdown(source, {
            resolveWikilink: (name) => {
                const match = published.find((n) => {
                    const base = n.vaultPath.split("/").pop() ?? n.vaultPath;
                    return base.replace(/\.md$/, "") === name;
                });
                return match ? match.slug : null;
            },
        });
        const isPublished = slugMap.get(path) ?? null;
        send(res, 200, { source, html, publishedSlug: isPublished });
    } catch (err) {
        send(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
});

middlewares.use("/api/obsidian/publish", async (req, res, next) => {
    if (req.method !== "POST") {
        return next();
    }

    try {
        const { path } = await readJson<{ path: string }>(req);
        const note = await publishNote(path);
        send(res, 200, { note });
    } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
});

middlewares.use("/api/obsidian/unpublish", async (req, res, next) => {
    if (req.method !== "POST") {
        return next();
    }

    try {
        const { slug } = await readJson<{ slug: string }>(req);
        await unpublishNote(slug);
        const remaining = await listPublished();
        send(res, 200, { remaining });
    } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
});
```

- [ ] **Step 2: Add `obsidianApi` to `src/dev-dashboard/ui/src/lib/api.ts`**

```ts
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import type { PublishedNote } from "@app/dev-dashboard/config";

export const obsidianApi = {
    tree: () => jsonFetch<{ entries: VaultEntry[] }>("/api/obsidian/tree"),
    note: (path: string) =>
        jsonFetch<{ source: string; html: string; publishedSlug: string | null }>(
            `/api/obsidian/note?path=${encodeURIComponent(path)}`
        ),
    publish: (path: string) =>
        jsonFetch<{ note: PublishedNote }>("/api/obsidian/publish", {
            method: "POST",
            body: JSON.stringify({ path }),
        }),
    unpublish: (slug: string) =>
        jsonFetch<{ remaining: PublishedNote[] }>("/api/obsidian/unpublish", {
            method: "POST",
            body: JSON.stringify({ slug }),
        }),
};
```

- [ ] **Step 3: `src/dev-dashboard/ui/src/components/ObsidianTree.tsx`**

```tsx
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useState } from "react";

interface Props {
    entries: VaultEntry[];
    onSelect: (relativePath: string) => void;
    selected: string | null;
}

function Node({ entry, onSelect, selected }: { entry: VaultEntry; onSelect: Props["onSelect"]; selected: string | null }) {
    const [open, setOpen] = useState(false);
    if (entry.isDirectory) {
        return (
            <li>
                <button
                    type="button"
                    className="flex w-full items-center gap-1 px-1 text-left font-mono text-[11px] text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                    onClick={() => setOpen((v) => !v)}
                >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Folder size={12} />
                    <span>{entry.name}</span>
                </button>
                {open ? (
                    <ul className="ml-3 mt-0.5 border-l border-[var(--dd-border)] pl-2">
                        {(entry.children ?? []).map((c) => (
                            <Node key={c.relativePath} entry={c} onSelect={onSelect} selected={selected} />
                        ))}
                    </ul>
                ) : null}
            </li>
        );
    }
    const isActive = selected === entry.relativePath;
    return (
        <li>
            <button
                type="button"
                className="flex w-full items-center gap-1 px-1 text-left font-mono text-[11px]"
                style={
                    isActive
                        ? { background: "var(--dd-accent-gradient)", color: "#0c0e10" }
                        : { color: "var(--dd-text-secondary)" }
                }
                onClick={() => onSelect(entry.relativePath)}
            >
                <FileText size={12} />
                <span>{entry.name.replace(/\.md$/, "")}</span>
            </button>
        </li>
    );
}

export function ObsidianTree({ entries, onSelect, selected }: Props) {
    return (
        <ul className="space-y-0.5">
            {entries.map((e) => (
                <Node key={e.relativePath} entry={e} onSelect={onSelect} selected={selected} />
            ))}
        </ul>
    );
}
```

- [ ] **Step 4: `src/dev-dashboard/ui/src/components/ObsidianReader.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, GlobeLock } from "lucide-react";
import { useState } from "react";
import { Button } from "@ui/components/button";
import { obsidianApi } from "../lib/api";

interface Props {
    path: string;
}

export function ObsidianReader({ path }: Props) {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ["obsidian", "note", path], queryFn: () => obsidianApi.note(path) });
    const [copied, setCopied] = useState(false);

    const publish = useMutation({
        mutationFn: () => obsidianApi.publish(path),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["obsidian", "note", path] }),
    });
    const unpublish = useMutation({
        mutationFn: (slug: string) => obsidianApi.unpublish(slug),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["obsidian", "note", path] }),
    });

    if (!data) {
        return <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">Loading…</div>;
    }
    const shareUrl = data.publishedSlug ? `${window.location.origin}/share/${data.publishedSlug}` : null;

    return (
        <div className="dd-panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--dd-border)] px-3 py-2 text-[11px]">
                <span className="font-mono text-[var(--dd-text-secondary)]">{path}</span>
                {shareUrl ? (
                    <div className="flex items-center gap-2">
                        <code className="text-[10px] text-[var(--dd-text-muted)]">{shareUrl}</code>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                                await navigator.clipboard.writeText(shareUrl);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            }}
                        >
                            <Copy size={12} /> {copied ? "copied" : "copy"}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => data.publishedSlug && unpublish.mutate(data.publishedSlug)}
                        >
                            <GlobeLock size={12} /> unpublish
                        </Button>
                    </div>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => publish.mutate()} disabled={publish.isPending}>
                        <Globe size={12} /> publish
                    </Button>
                )}
            </div>
            <article
                className="prose prose-invert flex-1 overflow-auto px-4 py-3 text-[13px]"
                /* eslint-disable-next-line react/no-danger */
                dangerouslySetInnerHTML={{ __html: data.html }}
            />
        </div>
    );
}
```

- [ ] **Step 5: `src/dev-dashboard/ui/src/routes/obsidian.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ObsidianReader } from "../components/ObsidianReader";
import { ObsidianTree } from "../components/ObsidianTree";
import { obsidianApi } from "../lib/api";

export function ObsidianRoute() {
    const { data } = useQuery({ queryKey: ["obsidian", "tree"], queryFn: obsidianApi.tree });
    const [selected, setSelected] = useState<string | null>(null);
    return (
        <div className="grid h-[calc(100vh-2rem)] grid-cols-[260px_1fr] gap-2">
            <aside className="dd-panel overflow-auto p-2">
                {data ? (
                    <ObsidianTree entries={data.entries} onSelect={setSelected} selected={selected} />
                ) : (
                    <p className="text-[var(--dd-text-muted)]">Loading vault…</p>
                )}
            </aside>
            <main className="overflow-hidden">
                {selected ? (
                    <ObsidianReader path={selected} />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        Pick a note on the left.
                    </div>
                )}
            </main>
        </div>
    );
}
```

- [ ] **Step 6: Register `/obsidian` in `router.tsx`**

```tsx
import { ObsidianRoute } from "./routes/obsidian";
const obsidianRoute = createRoute({ getParentRoute: () => rootRoute, path: "/obsidian", component: ObsidianRoute });
const routeTree = rootRoute.addChildren([indexRoute, ttydRoute, cmuxRoute, obsidianRoute]);
```

- [ ] **Step 7: Verify**

Open `http://localhost:3042/obsidian` → vault tree loads on the left. Click a note → renders on the right. Click **publish** → share URL chip appears with copy/unpublish buttons. Click **unpublish** → chip returns to plain "publish" button.

- [ ] **Step 8: Commit**

```bash
git add src/dev-dashboard/ui/vite-middleware.ts src/dev-dashboard/ui/src/lib/api.ts src/dev-dashboard/ui/src/components/ObsidianTree.tsx src/dev-dashboard/ui/src/components/ObsidianReader.tsx src/dev-dashboard/ui/src/routes/obsidian.tsx src/dev-dashboard/ui/src/router.tsx
git commit -m "feat(dev-dashboard): /obsidian panel — tree, reader, publish/unpublish"
```

---

## Task 12: Public /share/:slug route (Access bypass target)

**Files:**
- Modify: `src/dev-dashboard/ui/vite-middleware.ts` — add `/share/*` HTML handler (server-rendered standalone page; NOT a React route).

- [ ] **Step 1: Add the share handler**

The `/share/:slug` path must serve a fully self-contained HTML page (no Access cookie, no SPA hydration) so anyone with the slug can read the note. Append to `attachDevDashboardMiddleware`:

```ts
middlewares.use("/share/", async (req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }

    const url = new URL(req.url ?? "/", "http://x");
    const slug = url.pathname.replace(/^\/share\//, "").replace(/\/.*/, "");
    if (!slug) {
        return next();
    }

    try {
        const note = await findPublishedBySlug(slug);
        if (!note) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end("<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>");
        }
        const { obsidianVault } = await getConfig();
        const source = await readNote(obsidianVault, note.vaultPath);
        const published = await listPublished();
        const html = renderMarkdown(source, {
            resolveWikilink: (name) => {
                const match = published.find((n) => {
                    const base = n.vaultPath.split("/").pop() ?? n.vaultPath;
                    return base.replace(/\.md$/, "") === name;
                });
                return match ? match.slug : null;
            },
        });
        const title = (note.vaultPath.split("/").pop() ?? note.vaultPath).replace(/\.md$/, "");
        const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
            body{margin:0;background:#0c0e10;color:#e6edf3;font-family:Inter,system-ui,sans-serif;line-height:1.6;padding:48px 24px;}
            main{max-width:720px;margin:0 auto;}
            a{color:#34d399;}
            pre,code{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;background:#101316;border:1px solid #1e2428;border-radius:6px;padding:2px 4px;}
            pre code{padding:0;border:0;}
            pre{padding:12px;overflow:auto;}
            h1,h2,h3{color:#e6edf3;}
            .dd-wikilink{color:#34d399;text-decoration:underline;text-decoration-style:dotted;}
            .dd-wikilink-unresolved{color:#8b96a0;}
            footer{margin-top:48px;font-size:11px;color:#5b6670;text-align:center;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;}
        </style></head><body><main><article>${html}</article><footer>shared via dev-dashboard</footer></main></body></html>`;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(page);
    } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain");
        res.end(err instanceof Error ? err.message : String(err));
    }
});
```

Helper (add near the top of `vite-middleware.ts`):

```ts
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
```

- [ ] **Step 2: Verify locally**

Publish a note in `/obsidian`, copy the share URL it shows (e.g. `http://localhost:3042/share/abc123`), open it in an incognito/private window. The note should render standalone (no sidebar, no login). Tamper with the slug → 404.

- [ ] **Step 3: Commit**

```bash
git add src/dev-dashboard/ui/vite-middleware.ts
git commit -m "feat(dev-dashboard): /share/:slug — public standalone renderer (Access bypass target)"
```

---

## Task 13: Extend the Cloudflare tunnel config

**Files:**
- Modify: `/Users/Martin/.cloudflared/config.yml` — add second ingress rule.

- [ ] **Step 1: Back up current config**

```bash
cp ~/.cloudflared/config.yml ~/.cloudflared/config.yml.bak.$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Edit `~/.cloudflared/config.yml` so the `ingress` block is exactly:**

```yaml
tunnel: foltyn-home
credentials-file: /Users/Martin/.cloudflared/d60ec566-6ac0-4792-9e9b-f5f0e6dce60b.json

ingress:
  - hostname: mac.foltyn.dev
    path: /telegram-webhook
    service: http://127.0.0.1:8787
  - hostname: mac.foltyn.dev
    service: http://127.0.0.1:3042
  - service: http_status:404
```

Order matters — the more-specific `/telegram-webhook` rule MUST stay first.

- [ ] **Step 3: Validate the config**

Run: `cloudflared tunnel ingress validate`
Expected: `OK`.

- [ ] **Step 4: Test the ingress rule mapping**

```bash
cloudflared tunnel ingress rule https://mac.foltyn.dev/telegram-webhook
cloudflared tunnel ingress rule https://mac.foltyn.dev/share/abc123
cloudflared tunnel ingress rule https://mac.foltyn.dev/anything
```

Expected:
- First → matches rule #0 (port 8787).
- Second & third → matches rule #1 (port 3042).

- [ ] **Step 5: Reload the running tunnel**

If `cloudflared` is running as a launchd service:
```bash
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

If running in the foreground from an earlier session: Ctrl-C and `cloudflared tunnel run foltyn-home`.

- [ ] **Step 6: Smoke-test both routes through Cloudflare**

```bash
curl -s -o /dev/null -w "telegram-webhook (no secret) → %{http_code}\n" -X POST https://mac.foltyn.dev/telegram-webhook -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w "dashboard /        → %{http_code}\n" https://mac.foltyn.dev/
```

Expected:
- `/telegram-webhook` → `401` (OpenClaw rejects missing secret — proves the rule still works).
- `/` → `302` or `200` from Cloudflare Access (because the next task gates it). Until Task 14 lands, `/` returns 200 from the dashboard.

- [ ] **Step 7: Commit (only the backup mention — config.yml is user-machine-only, not in git)**

Nothing to commit here — `~/.cloudflared/config.yml` lives outside the repo. Move on.

---

## Task 14: Cloudflare Access — gate the dashboard, bypass webhooks & shares

**This is a manual one-time dashboard configuration.** No file changes. Document carefully in case the user needs to repeat or audit.

- [ ] **Step 1: Open Cloudflare Zero Trust → Access → Applications**

Navigate to https://one.dash.cloudflare.com/ → select your account → **Access → Applications → Add an application**.

- [ ] **Step 2: Create the "dev-dashboard" application**

- **Type:** Self-hosted
- **Application name:** `dev-dashboard`
- **Session duration:** 24 hours (default)
- **Application domain:** `mac.foltyn.dev`
- **Path:** leave blank (matches `/*`)

Click **Next**.

- [ ] **Step 3: Add the allow policy**

- **Policy name:** `martin`
- **Action:** Allow
- **Include:** Emails → `martin@foltyn.dev`

Click **Next** → **Save**.

- [ ] **Step 4: Configure the identity provider (if not already)**

Under **Access → Authentication**, ensure **One-time PIN** is enabled. (No extra IdP needed for personal use.)

- [ ] **Step 5: Add bypass policies for `/telegram-webhook` and `/share/*`**

Two clean options:

**Option A — same app, "Bypass" policy with path includes:**
1. Open the `dev-dashboard` app → **Policies** tab → **Add a policy**.
2. **Action:** Bypass.
3. **Rule:** Include → Everyone.
4. **Advanced settings → Paths included** (if the UI version supports per-policy paths): `/telegram-webhook`, `/share/*`.
5. Save.

**Option B (works on all Zero Trust UI versions) — two separate Bypass apps:**
1. Add application → Self-hosted → Domain `mac.foltyn.dev`, Path `/telegram-webhook`. Policy: Bypass everyone. Save.
2. Add application → Self-hosted → Domain `mac.foltyn.dev`, Path `/share/*`. Policy: Bypass everyone. Save.

Use whichever your dashboard version supports — both produce the same effective protection.

- [ ] **Step 6: Verify**

```bash
# Webhook bypass still works:
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mac.foltyn.dev/telegram-webhook -H 'Content-Type: application/json' -d '{}'
# Expected: 401 (OpenClaw rejects missing secret — no Access redirect)

# Share bypass: publish a note first via the dashboard, then:
SLUG=<paste-slug>
curl -s -o /dev/null -w "%{http_code}\n" https://mac.foltyn.dev/share/$SLUG
# Expected: 200 (note renders publicly)

# Dashboard is gated:
curl -s -o /dev/null -w "%{http_code}\n" https://mac.foltyn.dev/
# Expected: 302 or 200 with text/html showing the Cloudflare Access login page
```

Open `https://mac.foltyn.dev/` in a fresh browser → Cloudflare Access login screen → enter `martin@foltyn.dev` → receive OTP → login → dashboard loads.

- [ ] **Step 7: Add a note to the README**

Append to `src/dev-dashboard/README.md`:

```markdown
## Public surface

When tunneled via `foltyn-home`:
- `https://mac.foltyn.dev/` → Cloudflare Access gate (email OTP for `martin@foltyn.dev`).
- `https://mac.foltyn.dev/telegram-webhook` → bypass (OpenClaw secret-token auth).
- `https://mac.foltyn.dev/share/<slug>` → bypass (slug is the credential; `unpublish` revokes).
```

Commit:
```bash
git add src/dev-dashboard/README.md
git commit -m "docs(dev-dashboard): document public surface + Access bypasses"
```

---

## Task 15: End-to-end smoke + final verification

- [ ] **Step 1: Typecheck the whole tool**

```bash
bun run tsgo -p src/dev-dashboard/ui/tsconfig.json --noEmit
bun run tsgo --noEmit | rg "src/dev-dashboard" | tee /tmp/dd-tsc.log
```

Expected: zero errors mentioning `src/dev-dashboard`.

- [ ] **Step 2: Lint the tool**

```bash
bun run biome check src/dev-dashboard | tee /tmp/dd-lint.log
```

Expected: no errors. Fix any reported issues.

- [ ] **Step 3: Run the test suite for the tool**

```bash
bun test src/dev-dashboard/lib | tee /tmp/dd-tests.log
```

Expected: all tests pass. (ttyd tests need `ttyd` on PATH; cmux tests are mocked; obsidian tests use Storage temp config.)

- [ ] **Step 4: Manual end-to-end (local)**

With `tools dev-dashboard` running and cloudflared running:

1. `http://localhost:3042/ttyd` → spawn 2 terminals → confirm split mosaic + close works.
2. `http://localhost:3042/cmux` → confirm live snapshot (or "cmux not reachable" if cmux app isn't open).
3. `http://localhost:3042/obsidian` → browse, render, publish, unpublish a note.

- [ ] **Step 5: Manual end-to-end (through tunnel)**

In a fresh incognito window:

1. `https://mac.foltyn.dev/` → Access login → dashboard loads → all three panels behave the same as local.
2. Publish a note → copy share URL → open in a SECOND fresh incognito (no Access cookie) → renders without login.
3. `curl -X POST https://mac.foltyn.dev/telegram-webhook` → still `401` (OpenClaw still works through the tunnel).

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/dev-dashboard
```

- [ ] **Step 7: Final commit (if anything was tweaked during smoke)**

```bash
git status
# Resolve any leftover dirt — commit fixups or stash.
```

If nothing changed → done. Otherwise:
```bash
git commit -am "fix(dev-dashboard): smoke-test fixups"
git push
```

---

## Self-review

A pass over the plan against the spec:

**1. Spec coverage:** every spec section maps to ≥ 1 task —
- Tool structure (clarity-style) → Task 1.
- Persistent config (Zod + Storage) → Task 1.
- Vite stack + theme → Task 2.
- Slate Grid tokens → Task 2 (`slate-grid.css`).
- Sidebar + shell → Task 3.
- ttyd lib (types, free-port, manager) → Task 4.
- ttyd API + tabs + splits → Tasks 5 and 6.
- cmux lib (types, client, poller) → Task 7.
- cmux UI + live view → Task 8.
- cmux attach spike (timeboxed) → Task 9.
- Obsidian lib (reader, markdown, publish) → Task 10.
- Obsidian UI + publish actions → Task 11.
- `/share/:slug` public route → Task 12.
- Cloudflare tunnel ingress extension → Task 13.
- Cloudflare Access (gate + bypasses) → Task 14.
- Smoke + verification → Task 15.

**2. Placeholders / forbidden patterns:** none.
- The Task 9 attach spike uses concrete branches (path A vs path B) chosen by an inventory step; both paths land actual code/UI. Not a placeholder.

**3. Type consistency:** spot-checked —
- `TtydSession` shape created in Task 4 (`id`, `port`, `command`, `cwd`, `pid`, `startedAt`); consumed unchanged in Tasks 5, 6.
- `CmuxSnapshot` shape created in Task 7 (`fetchedAt`, `available`, `error?`, `workspaces`, `panes`); consumed unchanged in Task 8.
- `PublishedNote` defined in `config.ts` (Task 1) and re-exported from there for use by `publish.ts` (Task 10) and the obsidian middleware/API (Task 11). One canonical type, no drift.
- `VaultEntry` shape: `{ name, relativePath, isDirectory, children? }` — consistent between `reader.ts` (Task 10) and `ObsidianTree.tsx` (Task 11).

**4. Scope:** single sub-project, ≤ 16 hours of work. No decomposition needed.

---

## Execution Handoff

Plan complete and saved to `.claude/plans/2026-05-15-dev-dashboard.plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 15-task plan where each task is self-contained and the boundary is clean.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch with checkpoints for review.

Which approach?
