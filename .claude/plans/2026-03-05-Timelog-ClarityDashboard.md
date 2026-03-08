# Clarity + Azure DevOps Timelog Dashboard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Depends on:** `2026-03-05-Timelog-SharedUIFramework.md` (shared UI must be extracted first)
> **Depends on:** `2026-03-05-Timelog-ClarityIntegration.md` (Clarity API + CLI must exist)

**Goal:** Build a cyberpunk-themed web dashboard for managing ADO↔Clarity timelog synchronization — configure mappings, view exports, preview imports, and execute fills.

**Architecture:** Thin Vite app at `src/clarity/ui/` using shared UI framework from `src/utils/ui/`. TanStack Router for pages, TanStack Query for data. Server functions call Clarity API and ADO export library. Port 3071.

**Tech Stack:** React 19, Vite 7, TanStack Router + Query, Tailwind CSS 4, shared cyberpunk theme

---

## Phase 1: App Scaffold

### Task 1: Create Clarity dashboard app

**Files:**
- Create: `src/clarity/ui/vite.config.ts`
- Create: `src/clarity/ui/index.html`
- Create: `src/clarity/ui/package.json`
- Create: `src/clarity/ui/src/main.tsx`
- Create: `src/clarity/ui/src/App.tsx`
- Create: `src/clarity/ui/src/routes/__root.tsx`
- Create: `src/clarity/ui/src/routes/index.tsx`

**Step 1: Scaffold the thin app**

`vite.config.ts` (~10 lines):
```typescript
import { createDashboardViteConfig } from "../../../utils/ui/vite.base.js";

export default createDashboardViteConfig({
  root: __dirname,
  port: 3071,
});
```

`index.html` (~10 lines): Standard HTML with `<div id="root">`.

`package.json`: scripts for `dev`, `build`, `preview`.

`src/main.tsx` (~5 lines):
```tsx
import { createDashboardApp } from "../../../../utils/ui/create-app.js";
import { App } from "./App.js";
createDashboardApp({ App });
```

`src/App.tsx` (~30 lines): TanStack Router setup with route tree.

`src/routes/__root.tsx`: Uses `DashboardLayout` with:
- Title: `"CLARITY::TIMELOG"`
- Nav links: Mappings, Export, Import, Settings

`src/routes/index.tsx`: Landing page — overview card with:
- Connection status (green/red)
- Current month summary
- Quick action buttons

**Step 2: Verify it runs**

```bash
cd src/clarity/ui && bun install && bun run dev
# http://localhost:3071 shows themed "CLARITY::TIMELOG" dashboard
```

**Step 3: Commit**

```bash
git add src/clarity/ui/
git commit -m "feat(clarity-ui): scaffold cyberpunk dashboard with shared UI framework"
```

---

## Phase 2: Mappings Page

### Task 2: Mappings overview page

**Files:**
- Create: `src/clarity/ui/src/routes/mappings.tsx`
- Create: `src/clarity/ui/src/components/MappingTable.tsx`
- Create: `src/clarity/ui/src/components/AddMappingDialog.tsx`
- Create: `src/clarity/ui/src/server/mappings.ts`

**Step 1: Server functions for mappings**

```typescript
// src/clarity/ui/src/server/mappings.ts
// Read/write mappings from ~/.genesis-tools/clarity/config.json
// - getMappings(): ClarityMapping[]
// - addMapping(mapping): void
// - removeMapping(adoWorkItemId): void
// - getClarityProjects(timesheetId): TimeEntryRecord[]
// - getAdoWorkItems(): WorkItem[] (from ADO API)
```

**Step 2: Mapping table component**

Shows all current mappings in a cyberpunk-styled table:

```
┌─────────────────────────────────────┬───────────┬──────────────────────────┬───────────┐
│ Clarity Project                     │ Code      │ ADO Work Item            │ ADO ID    │
├─────────────────────────────────────┼───────────┼──────────────────────────┼───────────┤
│ 262351_Release_Externí_Capex        │ 00070705  │ Release                  │ 262351    │
│ Ceremonie_Externí_Capex             │ 00070706  │ Ceremonie                │ 262042    │
└─────────────────────────────────────┴───────────┴──────────────────────────┴───────────┘
```

With neon borders, hover glow, and action buttons (edit, unlink).

**Step 3: Add mapping dialog**

Modal dialog with:
1. Month/year picker → loads Clarity timesheets
2. Week selector → loads time entries
3. Clarity project dropdown (from timesheet entries)
4. ADO work item search input (fuzzy search)
5. Preview of the link → confirm button

**Step 4: Commit**

```bash
git add src/clarity/ui/src/routes/mappings.tsx src/clarity/ui/src/components/ src/clarity/ui/src/server/
git commit -m "feat(clarity-ui): add mappings page with table and add dialog"
```

---

## Phase 3: Export Page

### Task 3: ADO Export view

**Files:**
- Create: `src/clarity/ui/src/routes/export.tsx`
- Create: `src/clarity/ui/src/components/ExportTable.tsx`
- Create: `src/clarity/ui/src/components/ExportSummary.tsx`
- Create: `src/clarity/ui/src/server/export.ts`

**Step 1: Server function for export**

Calls `exportMonth()` from `src/azure-devops/lib/timelog/export.ts`.

**Step 2: Export page**

- Month/year picker at top
- Summary cards: total hours, entries count, projects count
- Grouped-by-week view with per-day breakdown
- Color-coded: mapped entries in amber (ready), unmapped in red (need linking)
- Hover on entry shows work item details

**Step 3: Export summary stats**

Donut chart (SVG, matching claude-history style) showing hours by work item.
Heatmap grid showing hours per day (matching HourlyHeatmap pattern).

**Step 4: Commit**

```bash
git add src/clarity/ui/src/routes/export.tsx src/clarity/ui/src/components/Export*
git commit -m "feat(clarity-ui): add ADO export page with summary charts"
```

---

## Phase 4: Import (Fill) Page

### Task 4: Clarity fill preview & execution

**Files:**
- Create: `src/clarity/ui/src/routes/import.tsx`
- Create: `src/clarity/ui/src/components/FillPreview.tsx`
- Create: `src/clarity/ui/src/components/FillWeekCard.tsx`
- Create: `src/clarity/ui/src/components/FillConfirmDialog.tsx`
- Create: `src/clarity/ui/src/server/fill.ts`

**Step 1: Server functions**

```typescript
// src/clarity/ui/src/server/fill.ts
// - computeFillPreview(month, year): FillPreview
//   (calls exportMonth + maps to Clarity, returns dry-run data)
// - executeFill(month, year, weekIds): FillResult
//   (actually calls Clarity API to update time entries)
```

**Step 2: Import page**

Two-step flow:

**Step A: Dry Run (always shown first)**

For each week in the month, show a `FillWeekCard`:

```
┌──────────────────────────────────────────────────────────────────────┐
│  WEEK: Feb 9-15, 2026                    Timesheet: 8524081         │
│  Status: ● Open                                                      │
├──────────────────────────────┬──────┬──────┬──────┬──────┬──────┬────┤
│ Clarity Project              │ Mon  │ Tue  │ Wed  │ Thu  │ Fri  │  Σ │
├──────────────────────────────┼──────┼──────┼──────┼──────┼──────┼────┤
│ 262351_Release               │ 3.3h │ 3.3h │ 3.3h │ 3.3h │ 3.3h │16.5│
│ Ceremonie                    │ 0.5h │ 0.5h │ 0.5h │ 0.5h │ 0.5h │ 2.5│
├──────────────────────────────┼──────┼──────┼──────┼──────┼──────┼────┤
│ TOTAL                        │ 3.8h │ 3.8h │ 3.8h │ 3.8h │ 3.8h │19.0│
│ EXPECTED                     │ 7.5h │ 7.5h │ 7.5h │ 7.5h │ 7.5h │37.5│
└──────────────────────────────┴──────┴──────┴──────┴──────┴──────┴────┘
⚠ Unmapped: 18.5h (3 ADO work items not linked to Clarity)
```

Color coding:
- Green: matches expected hours
- Amber: below expected (gaps)
- Red: over expected (conflicts)
- Gray: weekend/non-work days

**Step B: Execute**

Big "EXECUTE FILL" button (cyber style with glow):
- Disabled until user reviews dry run
- Confirmation dialog listing all changes
- Progress bar during execution
- Results summary after completion

Each week card has a checkbox — user can select which weeks to fill.

**Step 3: Commit**

```bash
git add src/clarity/ui/src/routes/import.tsx src/clarity/ui/src/components/Fill*
git commit -m "feat(clarity-ui): add import page with dry-run preview and fill execution"
```

---

## Phase 5: Settings Page

### Task 5: Settings and configuration

**Files:**
- Create: `src/clarity/ui/src/routes/settings.tsx`
- Create: `src/clarity/ui/src/components/AuthStatus.tsx`
- Create: `src/clarity/ui/src/components/CurlPasteInput.tsx`

**Step 1: Settings page**

- **Auth Status**: Green/red indicator, shows configured base URL, last successful API call
- **Update Auth**: Paste cURL input (multi-line textarea), parse and update config
- **Test Connection**: Button that hits Clarity API and shows result
- **Config JSON**: Read-only view of current config (redacted auth tokens)
- **Danger Zone**: Reset config, clear cache

**Step 2: Commit**

```bash
git add src/clarity/ui/src/routes/settings.tsx src/clarity/ui/src/components/Auth* src/clarity/ui/src/components/Curl*
git commit -m "feat(clarity-ui): add settings page with auth management"
```

---

## Phase 6: Integration

### Task 6: Wire up CLI to launch dashboard

**Files:**
- Modify: `src/clarity/index.ts` — add `dashboard` subcommand

**Step 1: Add dashboard command**

```bash
tools clarity dashboard  # Opens browser to http://localhost:3071, starts dev server
```

Runs `bun run dev` in `src/clarity/ui/` and opens browser automatically.

**Step 2: Commit**

```bash
git add src/clarity/index.ts
git commit -m "feat(clarity): add 'dashboard' command to launch web UI"
```

---

## Design Tokens

Consistent with claude-history-dashboard cyberpunk theme:

| Element | Color | Usage |
|---------|-------|-------|
| Primary (amber) | `oklch(0.78 0.19 75)` | Buttons, active states, highlights |
| Secondary (cyan) | `oklch(0.68 0.17 195)` | Accents, links, secondary actions |
| Success | Green variant | Mapped items, successful operations |
| Warning | Amber variant | Gaps, below-expected values |
| Error | Red variant | Unmapped items, failures, over-expected |
| Background | `oklch(0.06 0.01 280)` | Deep space black |
| Card | `oklch(0.08 0.01 280)` | Glass card backgrounds |

All using the shared `styles.css` + `cyberpunk.css` — no custom colors needed.
