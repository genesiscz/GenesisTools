# 04 — Mobile Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> **Depends on 03** (`@devdashboard/contract`). **Standing rule (ADR §0): search docs on demand** —
> use `context7` (`/websites/expo_dev_versions_v55_0_0`), the `expo:*` skills, and web search before
> any native integration; versions move.

**Goal:** Scaffold the Expo SDK 55 app (`DevDashboard/mobile/`) — navigation, theming, data layer,
storage, the connection/auth core, app shell, and the **Appium E2E harness (POM)** — so feature
plans 05–09 drop screens onto a working, testable foundation.

**Architecture:** Expo SDK 55 / RN 0.83 / React 19.2, New-Arch (always-on), dev-client/prebuild.
expo-router v7 native tabs for nav; NativeWind v5 (CSS-first, `--dd-*` tokens via `@theme`; v4.2.4
fallback) for theming; TanStack Query v5 (server-state) + Zustand (UI state); the `@devdashboard/
contract` client wired with `expo/fetch`, an `expo-secure-store`-backed `authHeader`, and an
`expo/fetch` SSE factory; `expo-sqlite/kv-store` (prefs) + `expo-sqlite` (offline cache) + secure
store (secrets). Appium specs + Page Objects gate every feature.

**Tech Stack:** expo-router, nativewind, @tanstack/react-query, zustand, expo-secure-store,
expo-sqlite, expo/fetch, @react-native-community/netinfo, react-native-safe-area-context,
appium + webdriverio (E2E).

**Definition of done:** `npx expo run:ios` launches a dev-client showing native tabs; a debug
"Connect" flow stores a base URL + Basic creds in SecureStore; the contract client fetches
`/api/system/pulse` against a running Agent and renders raw JSON on a debug screen; `bun run e2e`
launches Appium and a smoke spec passes (app boots, tabs visible).

---

## File Structure

**Create (under `DevDashboard/mobile/`):**
- `app.json` / `app.config.ts` — Expo config (New Arch, plugins, iOS/Android perms).
- `package.json`, `tsconfig.json`, `babel.config.js`, `metro.config.js`, `global.css` — toolchain.
- `app/_layout.tsx` — root providers (QueryClient, SafeArea, Theme, connection gate).
- `app/(tabs)/_layout.tsx` — native tabs; `app/(tabs)/{index,terminal,sessions,qa,more}.tsx` — tab screens (placeholders here; filled by 05–09).
- `app/connect.tsx` — connection/tier picker (filled by plan 02; stub here).
- `src/lib/contract-client.ts` — builds the `@devdashboard/contract` client for RN.
- `src/lib/query.ts` — QueryClient + `onlineManager`/`focusManager` wiring.
- `src/lib/sse.ts` — `expo/fetch` SSE factory (the `eventSourceFactory` the contract expects).
- `src/lib/storage/secure.ts` — SecureStore helpers (creds, E2E keys).
- `src/lib/storage/kv.ts` — `expo-sqlite/kv-store` typed prefs.
- `src/lib/storage/db.ts` — `expo-sqlite` open + migrations (offline cache).
- `src/state/connection.ts` — Zustand store (tier, baseUrl, creds-present, status).
- `src/state/settings.ts` — Zustand store (theme, active terminal driver, etc.).
- `src/theme/tokens.css` — the `--dd-*` token set ported from web, via `@theme`.
- `src/ui/{Screen,Card,Banner,Loading,Empty,ErrorBoundary}.tsx` — shell primitives.
- `e2e/wdio.conf.ts`, `e2e/pages/base.page.ts`, `e2e/pages/app.page.ts`, `e2e/specs/smoke.spec.ts` — Appium harness.
- `src/lib/__tests__/*` — pure-logic unit tests.

**Modify (repo root):** add the bun workspace entry so `@devdashboard/contract` resolves (see Task 2).

---

### Task 1: Scaffold the Expo SDK 55 app

**Files:** Create `DevDashboard/mobile/` via the Expo template.

- [ ] **Step 1: Create the app (pinned to SDK 55)**

Run (from repo root):
```bash
cd DevDashboard && bunx create-expo-app@latest mobile --template default
cd mobile && npx expo install expo@^55.0.0
```
Expected: a `DevDashboard/mobile/` Expo project. Verify `package.json` shows `"expo": "~55.x"`.

- [ ] **Step 2: Confirm New Architecture + TypeScript**

Verify `app.json` has no `newArchEnabled: false` (SDK 55 is always-on). Confirm `tsconfig.json`
extends `expo/tsconfig.base`. Run `npx expo-doctor` and fix any flagged version mismatch with
`npx expo install --fix`.
Expected: expo-doctor passes.

- [ ] **Step 3: Install the foundation native deps (SDK-55 pins via expo install)**

```bash
npx expo install expo-router expo-secure-store expo-sqlite expo-background-task expo-notifications \
  react-native-safe-area-context react-native-screens react-native-gesture-handler \
  react-native-reanimated react-native-worklets @react-native-community/netinfo
bun add @tanstack/react-query zustand
```
Expected: versions resolve to the SDK-55 pins (reanimated 4.2.1, worklets 0.7.4, screens ~4.23, safe-area ~5.6.2). Add `react-native-worklets/plugin` to `babel.config.js`.

- [ ] **Step 4: Commit the scaffold**

```bash
git add DevDashboard/mobile
git commit -m "feat(dd-mobile): scaffold Expo SDK 55 app (New Arch, router, query, zustand)"
```

---

### Task 2: Package and wire `@devdashboard/contract`

> The contract (plan 03) is authored at `src/dev-dashboard/contract/`. Expose it as a local
> workspace package so the Expo Metro bundler resolves it without the repo's `@app/*` alias.

**Files:** `src/dev-dashboard/contract/package.json` (create), root `package.json` (modify),
`DevDashboard/mobile/metro.config.js` + `tsconfig.json` (modify).

- [ ] **Step 1: Add the contract package manifest**

Create `src/dev-dashboard/contract/package.json`:
```json
{
  "name": "@devdashboard/contract",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "sideEffects": false
}
```

- [ ] **Step 2: Register the bun workspace (root `package.json`)**

Add `"workspaces": ["src/dev-dashboard/contract", "DevDashboard/mobile"]` (merge if `workspaces`
already exists). Run `bun install`.
Expected: `node_modules/@devdashboard/contract` symlinks to the source.

- [ ] **Step 3: Make Metro resolve the workspace package**

In `DevDashboard/mobile/metro.config.js`, enable monorepo resolution:
```javascript
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(workspaceRoot, "node_modules"),
];
module.exports = config;
```
Add to `DevDashboard/mobile/tsconfig.json` `compilerOptions.paths`:
`"@devdashboard/contract": ["../../src/dev-dashboard/contract/index.ts"]`.

- [ ] **Step 4: Verify the import resolves (the purity test pays off)**

Create `src/lib/__tests__/contract-import.test.ts`:
```typescript
import { paths } from "@devdashboard/contract";
import { describe, expect, it } from "bun:test";

describe("contract import", () => {
    it("resolves the endpoint catalog without dragging server runtime", () => {
        expect(paths.pulse()).toBe("/api/system/pulse");
    });
});
```
Run: `bun test src/lib/__tests__/contract-import.test.ts` (from `DevDashboard/mobile`)
Expected: PASS (proves the pure contract imports cleanly into the app workspace).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/contract/package.json package.json DevDashboard/mobile/metro.config.js DevDashboard/mobile/tsconfig.json DevDashboard/mobile/src/lib/__tests__/contract-import.test.ts
git commit -m "feat(dd-mobile): expose @devdashboard/contract as a workspace package"
```

---

### Task 3: Storage layer (SecureStore + KV + SQLite)

**Files:** Create `src/lib/storage/{secure,kv,db}.ts` + tests.

- [ ] **Step 1: SecureStore helpers (secrets only)**

```typescript
import * as SecureStore from "expo-secure-store";

const CREDS_KEY = "dd.basicAuth";

export interface BasicCreds {
    username: string;
    password: string;
}

export async function saveBasicCreds(creds: BasicCreds): Promise<void> {
    await SecureStore.setItemAsync(CREDS_KEY, JSON.stringify(creds));
}

export async function loadBasicCreds(): Promise<BasicCreds | null> {
    const raw = await SecureStore.getItemAsync(CREDS_KEY);

    if (!raw) {
        return null;
    }

    return JSON.parse(raw) as BasicCreds;
}

export async function clearBasicCreds(): Promise<void> {
    await SecureStore.deleteItemAsync(CREDS_KEY);
}
```
> E2E keypairs (plan 02 managed tier) also live here under separate keys — never in KV/SQLite.

- [ ] **Step 2: Typed prefs via `expo-sqlite/kv-store`**

```typescript
import Storage from "expo-sqlite/kv-store";

export type TerminalDriverId = "webview-ttyd" | "webview-html" | "native";

interface Prefs {
    "dd.theme": "system" | "light" | "dark";
    "dd.terminalDriver": TerminalDriverId;
    "dd.lastSessionId": string;
}

export async function getPref<K extends keyof Prefs>(key: K): Promise<Prefs[K] | null> {
    const v = await Storage.getItem(key);

    return v === null ? null : (JSON.parse(v) as Prefs[K]);
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
    await Storage.setItem(key, JSON.stringify(value));
}
```

- [ ] **Step 3: `expo-sqlite` open + migrations (offline cache)**

```typescript
import * as SQLite from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const MIGRATIONS: string[] = [
    `CREATE TABLE IF NOT EXISTS pulse_history (
        metric TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (metric, ts)
    );`,
    `CREATE TABLE IF NOT EXISTS qa_entries (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );`,
];

export function getDb(): Promise<SQLite.SQLiteDatabase> {
    dbPromise ??= (async () => {
        const db = await SQLite.openDatabaseAsync("devdashboard.db");
        await db.execAsync("PRAGMA journal_mode = WAL;");

        for (const stmt of MIGRATIONS) {
            await db.execAsync(stmt);
        }

        return db;
    })();

    return dbPromise;
}
```

- [ ] **Step 4: Test the prefs round-trip (mock the native module)**

Create `src/lib/storage/__tests__/kv.test.ts` mocking `expo-sqlite/kv-store` with an in-memory Map;
assert `setPref`/`getPref` round-trips a typed value. Run with the RN test runner.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/lib/storage
git commit -m "feat(dd-mobile): storage layer — secure-store secrets, sqlite kv prefs, sqlite cache"
```

---

### Task 4: Connection store + contract client + SSE factory

**Files:** Create `src/state/connection.ts`, `src/lib/sse.ts`, `src/lib/contract-client.ts` + tests.

- [ ] **Step 1: Connection Zustand store**

```typescript
import { create } from "zustand";
import type { TerminalDriverId } from "@app-mobile/lib/storage/kv";

export type Tier = "lan" | "tailscale" | "cloudflared-self" | "managed";
export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

interface ConnectionState {
    tier: Tier;
    baseUrl: string | null;
    authHeader: string | null;
    status: ConnStatus;
    setEndpoint: (tier: Tier, baseUrl: string, authHeader: string | null) => void;
    setStatus: (status: ConnStatus) => void;
    reset: () => void;
}

export const useConnection = create<ConnectionState>((set) => ({
    tier: "lan",
    baseUrl: null,
    authHeader: null,
    status: "disconnected",
    setEndpoint: (tier, baseUrl, authHeader) => set({ tier, baseUrl, authHeader }),
    setStatus: (status) => set({ status }),
    reset: () => set({ baseUrl: null, authHeader: null, status: "disconnected" }),
}));
```

- [ ] **Step 2: `expo/fetch` SSE factory (the contract's `eventSourceFactory`)**

```typescript
import { fetch as expoFetch } from "expo/fetch";
import type { EventSourceLike } from "@devdashboard/contract";

/** Minimal EventSource-like over expo/fetch streaming + an SSE line parser. */
export function makeExpoEventSource(url: string, authHeader: string | null): EventSourceLike {
    const controller = new AbortController();
    const es: EventSourceLike = { close: () => controller.abort(), onmessage: null, onerror: null };

    (async () => {
        try {
            const res = await expoFetch(url, {
                headers: { Accept: "text/event-stream", ...(authHeader ? { Authorization: authHeader } : {}) },
                signal: controller.signal,
            });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            for (;;) {
                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                let idx = buffer.indexOf("\n\n");

                while (idx !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));

                    if (dataLine && es.onmessage) {
                        es.onmessage({ data: dataLine.slice(5).trim() });
                    }

                    idx = buffer.indexOf("\n\n");
                }
            }
        } catch (err) {
            es.onerror?.(err);
        }
    })();

    return es;
}
```
> The frame-parsing (split on `\n\n`, take `data:`) is extracted into `parseSseFrame()` and unit-tested.

- [ ] **Step 3: Build the contract client for RN**

```typescript
import { createDashboardClient } from "@devdashboard/contract";
import { fetch as expoFetch } from "expo/fetch";
import { useConnection } from "@app-mobile/state/connection";
import { makeExpoEventSource } from "@app-mobile/lib/sse";

export function buildClient() {
    const { baseUrl, authHeader } = useConnection.getState();

    if (!baseUrl) {
        throw new Error("Not connected");
    }

    return createDashboardClient({
        baseUrl,
        fetch: expoFetch as unknown as typeof fetch,
        authHeader: () => useConnection.getState().authHeader ?? undefined,
        eventSourceFactory: (url) => makeExpoEventSource(url, authHeader),
    });
}
```

- [ ] **Step 4: Unit-test the SSE frame parser**

`src/lib/__tests__/sse.test.ts`: feed `"data: {\"id\":\"1\"}\n\n"` to `parseSseFrame`, assert it yields
the JSON string. Assert keep-alive `":ping\n\n"` yields nothing. Run via the RN test runner.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/src/state/connection.ts DevDashboard/mobile/src/lib/sse.ts DevDashboard/mobile/src/lib/contract-client.ts DevDashboard/mobile/src/lib/__tests__/sse.test.ts
git commit -m "feat(dd-mobile): connection store + RN contract client + expo/fetch SSE"
```

---

### Task 5: TanStack Query provider (netinfo + AppState wiring)

**Files:** Create `src/lib/query.ts`; modify `app/_layout.tsx`.

- [ ] **Step 1: QueryClient + online/focus managers**

```typescript
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected)))
);

export function wireAppStateFocus(): () => void {
    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
        focusManager.setFocused(status === "active");
    });

    return () => sub.remove();
}

export const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 2, staleTime: 5_000 } },
});
```

- [ ] **Step 2: Wrap the app (root layout)** — `QueryClientProvider` + `SafeAreaProvider` + theme + `wireAppStateFocus()` in an effect. (Full `_layout.tsx` shown in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add DevDashboard/mobile/src/lib/query.ts
git commit -m "feat(dd-mobile): TanStack Query client with netinfo + AppState integration"
```

---

### Task 6: Theming — NativeWind v4.2.4 GA (+ `--dd-*` tokens), v5 migration later

> **Research file 09 verdict = `start-v4-migrate-later`** (NativeWind v5 is still `5.0.0-preview` with
> blocking issues — unsafe for a commercial foundation). **Start on NativeWind v4.2.4 (GA, Tailwind v3
> config).** A later migration to v5 (CSS-first `@theme`) is a tracked follow-up; keep the `--dd-*`
> token NAMES identical so the migration is config-only. The token VALUES are ported from the web
> dashboard's `--dd-*` set. (If the user prefers v5-now despite the preview risk, swap this task for
> the v5 path in research 09.)

**Files:** `global.css`, `src/theme/tokens.css`, `babel.config.js`/`metro.config.js`, `tailwind`/`postcss` config per the chosen NativeWind major.

- [ ] **Step 1: Install + configure (NativeWind v4.2.4 GA — consult `expo:expo-tailwind-setup`)**

```bash
# v4 GA path (Tailwind v3 config). Stable, production-proven on SDK 55.
npx expo install nativewind@4.2.4 tailwindcss@^3 tailwind-merge clsx
```
Create `tailwind.config.js` (content globs over `app/**` + `src/**`, `presets: [require("nativewind/preset")]`),
add the NativeWind babel preset, and wire `global.css` import in the root layout. (The v5 CSS-first
`@theme` path lives in research file 09 for the later migration.)

- [ ] **Step 2: Port the `--dd-*` tokens via `@theme`**

In `src/theme/tokens.css` (imported by `global.css`), declare the dashboard tokens (read the exact
values from `src/dev-dashboard/ui/src/slate-grid.css` + the design-system doc) as Tailwind v4
`@theme` custom properties and `light-dark()` for dark mode, e.g. `--color-dd-bg-panel`,
`--color-dd-border`, `--color-dd-text-muted`. Verify a `className="bg-dd-bg-panel"` resolves.

- [ ] **Step 3: Smoke a styled component**

Render a `<View className="bg-dd-bg-panel p-4 rounded-2xl">` in the index screen; confirm it picks up
the token color in the dev-client.
Expected: themed surface renders.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/global.css DevDashboard/mobile/src/theme DevDashboard/mobile/package.json DevDashboard/mobile/babel.config.js
git commit -m "feat(dd-mobile): NativeWind theming + ported --dd-* tokens"
```

---

### Task 7: Navigation — expo-router native tabs

**Files:** `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/(tabs)/{index,terminal,sessions,qa,more}.tsx`.

- [ ] **Step 1: Native tabs layout (consult `expo:building-native-ui`)**

```tsx
import { NativeTabs } from "expo-router/native-tabs";

export default function TabsLayout() {
    return (
        <NativeTabs>
            <NativeTabs.Screen name="index" options={{ title: "Pulse" }} />
            <NativeTabs.Screen name="terminal" options={{ title: "Terminal" }} />
            <NativeTabs.Screen name="sessions" options={{ title: "Sessions" }} />
            <NativeTabs.Screen name="qa" options={{ title: "QA" }} />
            <NativeTabs.Screen name="more" options={{ title: "More" }} />
        </NativeTabs>
    );
}
```

- [ ] **Step 2: Placeholder screens** — each tab renders a `<Screen>` with its title + a debug
"connection: <status>" line. (Filled by 05–09.) Add `accessibilityLabel`s (`tab-pulse`, etc.) for Appium.

- [ ] **Step 3: Smoke** — `npx expo run:ios`; confirm 5 native tabs render and switch.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/app
git commit -m "feat(dd-mobile): expo-router native tabs + placeholder screens"
```

---

### Task 8: App shell — providers, connection gate, error boundary, primitives

**Files:** `app/_layout.tsx` (final), `src/ui/{Screen,Card,Banner,Loading,Empty,ErrorBoundary}.tsx`, `app/connect.tsx` (stub).

- [ ] **Step 1: Root layout wiring**

```tsx
import "../global.css";
import { Stack } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useEffect } from "react";
import { queryClient, wireAppStateFocus } from "@app-mobile/lib/query";
import { useConnection } from "@app-mobile/state/connection";
import { ErrorBoundary } from "@app-mobile/ui/ErrorBoundary";

export default function RootLayout() {
    useEffect(() => wireAppStateFocus(), []);
    const baseUrl = useConnection((s) => s.baseUrl);

    return (
        <SafeAreaProvider>
            <QueryClientProvider client={queryClient}>
                <ErrorBoundary>
                    <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Protected guard={baseUrl !== null}>
                            <Stack.Screen name="(tabs)" />
                        </Stack.Protected>
                        <Stack.Screen name="connect" />
                    </Stack>
                </ErrorBoundary>
            </QueryClientProvider>
        </SafeAreaProvider>
    );
}
```
> If `Stack.Protected` is unavailable in the installed router version (verify via docs), redirect to
> `/connect` from `(tabs)/_layout` when `baseUrl === null`.

- [ ] **Step 2: Shell primitives** — `<Screen>` (SafeArea + themed bg + scroll), `<Card>` (uses
`bg-dd-bg-panel` token), `<Banner>` (connection status), `<Loading>`/`<Empty>` states,
`<ErrorBoundary>` (class component, logs + retry). Each with `accessibilityLabel` for Appium.

- [ ] **Step 3: Connect stub** — `app/connect.tsx` renders a debug form (base URL + user/pass) that
calls `saveBasicCreds` + `setEndpoint` and probes `/api/system/pulse`. (Plan 02 replaces this with the
full tier picker + QR pairing.)

- [ ] **Step 4: End-to-end debug check** — start the Agent (`tools dev-dashboard agent --port 3043`),
enter `http://<mac-lan-ip>:3043` + creds on the phone, confirm the index screen shows live pulse JSON.

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/app DevDashboard/mobile/src/ui
git commit -m "feat(dd-mobile): app shell — providers, connection gate, primitives, error boundary"
```

---

### Task 9: Appium E2E harness + Page Object base + smoke spec (ADR §8)

> This is the iteration harness the user requires — every later feature adds a spec here.

**Files:** `e2e/wdio.conf.ts`, `e2e/pages/base.page.ts`, `e2e/pages/app.page.ts`, `e2e/specs/smoke.spec.ts`, `package.json` scripts.

- [ ] **Step 1: Install + configure (consult the `appium` skill / `appium_skills`)**

```bash
bun add -d webdriverio @wdio/cli @wdio/local-runner @wdio/mocha-framework appium appium-xcuitest-driver
```
`e2e/wdio.conf.ts`: iOS sim capabilities (`platformName: "iOS"`, `appium:automationName: "XCUITest"`,
`appium:app: <path to the dev-client .app>`), `specs: ["./specs/**/*.spec.ts"]`.

- [ ] **Step 2: Page Object base**

```typescript
export abstract class BasePage {
    protected byId(id: string): ChainablePromiseElement {
        return $(`~${id}`); // accessibility-id locator
    }

    async waitForVisible(id: string, timeout = 10_000): Promise<void> {
        await this.byId(id).waitForDisplayed({ timeout });
    }
}
```

- [ ] **Step 3: AppPage + smoke spec**

```typescript
// e2e/pages/app.page.ts
import { BasePage } from "./base.page";

class AppPage extends BasePage {
    async tabsVisible(): Promise<boolean> {
        await this.waitForVisible("tab-pulse");
        return (await this.byId("tab-terminal").isDisplayed());
    }
    async openTab(name: "pulse" | "terminal" | "sessions" | "qa" | "more"): Promise<void> {
        await this.byId(`tab-${name}`).click();
    }
}
export const appPage = new AppPage();
```
```typescript
// e2e/specs/smoke.spec.ts
import { appPage } from "../pages/app.page";

describe("app boots", () => {
    it("shows the native tabs", async () => {
        expect(await appPage.tabsVisible()).toBe(true);
    });
    it("switches to the Terminal tab", async () => {
        await appPage.openTab("terminal");
        await appPage.waitForVisible("screen-terminal");
    });
});
```

- [ ] **Step 4: Scripts + run**

`package.json`: `"e2e": "wdio run e2e/wdio.conf.ts"`, `"e2e:build": "npx expo run:ios --configuration Release"`.
Run: build the dev-client, boot the iOS sim, `bun run e2e`.
Expected: smoke spec PASSES (tabs visible, tab switch works).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/e2e DevDashboard/mobile/package.json
git commit -m "test(dd-mobile): Appium E2E harness + Page Object base + smoke spec"
```

---

## Self-Review checklist

1. **Foundation complete:** scaffold, contract resolution (workspace + metro), storage (secure/kv/
   sqlite), connection store, contract client + SSE, query provider, theming + tokens, native tabs,
   app shell, Appium harness — each a committed task.
2. **Type consistency with the ADR:** `Transport`/tier names (`lan|tailscale|cloudflared-self|managed`),
   `TerminalDriverId`, the `@devdashboard/contract` client method names match plans 02/03/06.
3. **Docs-on-demand honored:** native-tabs, NativeWind, Appium, expo/fetch steps each say "consult
   the current docs/skill" — no version coded from memory.
4. **NativeWind fallback:** v5 primary with the explicit v4.2.4 fallback gate (research file 09).
5. **No placeholders:** every code step shows real code; the only intentional stubs (placeholder
   screens, connect form) are explicitly handed to plans 02/05–09.

## Appium E2E (per ADR §8)

- **Harness delivered here** (Task 9): `wdio.conf.ts` + `BasePage` + `AppPage` + `smoke.spec.ts`.
- **Page Objects to extend in later plans:** `PulsePage` (05), `TerminalPage` (06), `SessionsPage`
  (06), `QaPage` (07), `ObsidianPage` (08), `ConnectPage` (02).
- A foundation task is "done" only when `bun run e2e` passes the smoke spec on the iOS dev-client.

## Hand-off

Unblocks **05–09** (screens mount on the tabs + shell), **02** (replaces the connect stub with the
tier picker + QR pairing), **06** (registers terminal drivers + adds `TerminalPage`). The theming
major (v5 vs v4) is finalized from research file 09 when `w83na3gs2` completes.
