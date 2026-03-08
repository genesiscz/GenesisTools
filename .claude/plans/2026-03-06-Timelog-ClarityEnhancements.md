# Clarity UI Enhancements — Implementation Plan

**Date:** 2026-03-06
**Branch:** feat/timelog-clarity

---

## Enhancement 1: Type Extraction — Move domain types from UI to lib

**Problem:** Domain types (`ClarityTask`, `TimesheetWeek`, `TimelogWorkItem`, `AdoWorkItem`, `ExportEntry`) are defined inside UI components. UI should be a thin consumer; data types belong in `src/clarity/lib/` or `src/azure-devops/`.

**Tasks:**

### Task 1: Create `src/clarity/lib/types.ts` with shared domain types

Move/consolidate:
- `ClarityTask` (duplicated in AddMappingForm.tsx + server/mappings.ts) → `src/clarity/lib/types.ts`
- `TimesheetWeek` — already in `src/clarity/lib/timesheet-weeks.ts` (UI should import from there, remove local duplicate)
- `TimelogWorkItem` — identical to `TimelogWorkItemGroup` in `src/clarity/lib/timelog-workitems.ts` (UI should import, remove duplicate)
- `AdoWorkItem` — subset of `EnrichedWorkItem` from `src/azure-devops/lib/work-item-enrichment.ts` (UI should import, remove duplicate)
- `ExportEntry` in ExportTable.tsx — maps to `ExportedEntry` from `src/azure-devops/lib/timelog/export.ts` (align types)

**Files to modify:**
- Create: `src/clarity/lib/types.ts` (for `ClarityTask`)
- Modify: `src/clarity/ui/src/components/AddMappingForm.tsx` — remove local types, import from lib
- Modify: `src/clarity/ui/src/components/ExportTable.tsx` — import `ExportedEntry` from lib
- Modify: `src/clarity/ui/src/server/mappings.ts` — import `ClarityTask` from lib

**Keep in UI** (pure React props): `AddMappingFormProps`, `ExportTableProps`, `MappingTableProps`, `FillWeekCardProps`, `MonthPickerProps`, `AppContextValue`

---

## Enhancement 2: Grouped Mapping Table with Drag-and-Drop

**Problem:** Current "Configured Mappings" shows a flat table. Should be grouped by Clarity project, with ability to drag ADO work items between groups.

**Tasks:**

### Task 2: Redesign MappingTable — group by Clarity project

**Current:** Flat table with columns: Clarity Project | Code | ADO Work Item | ADO ID | Actions

**New design:**
```
┌─────────────────────────────────────────────────────────────────┐
│ 262351_Release_Externí_Capex                        CODE: 00070705 │
├─────────────────────────────────────────────────────────────────┤
│ ██ Release (Task)                              #262351  → ✕     │
│ ██ Deploy pipeline fix (Bug)                   #267890  → ✕     │
├─────────────────────────────────────────────────────────────────┤
│ B_107402_Redesign_Login/Logout_Externí_Capex     CODE: 00070739 │
├─────────────────────────────────────────────────────────────────┤
│ ██ Login - Zobrazení pop-upu (Bug)             #266576  → ✕     │
│ ██ Login - LoginPage LOGO (Bug)                #267300  → ✕     │
│ ██ Login - Pořadí socek (Bug)                  #267734  → ✕     │
└─────────────────────────────────────────────────────────────────┘
```

Each group:
- Header row: Clarity project name + code on second line
- Body rows: ADO work items with:
  - Left border color = ADO work item type color (from `WorkItemTypeColor`)
  - Work item title as clickable link to ADO
  - Work item type badge (colored)
  - Work item ID (#NNNNN)
  - Delete button (✕)

### Task 3: Implement drag-and-drop between Clarity project groups

**Tech:** Use `@dnd-kit/core` + `@dnd-kit/sortable` (or native HTML drag-and-drop)

**Behavior:**
1. Each ADO work item row is draggable
2. Each Clarity project group is a drop zone
3. On drop: fire API request to update the mapping (change the Clarity project for that ADO work item)
4. Show toast on success/error
5. Optimistic update — move the row immediately, revert on error

**API calls on drop:**
- Remove old mapping: `POST /api/remove-mapping` with `{ adoWorkItemId }`
- Add new mapping: `POST /api/add-mapping` with `{ adoWorkItemId, clarityTaskId, clarityTaskName, ... }`
- Or: single `POST /api/move-mapping` endpoint that does both atomically

**Files:**
- Modify: `src/clarity/ui/src/components/MappingTable.tsx` — grouped layout + drag-and-drop
- Modify: `src/clarity/ui/src/server/mappings.ts` — add `moveMapping()` function
- Modify: `src/clarity/ui/src/server/api-plugin.ts` — add `/api/move-mapping` endpoint
- Add toast library (or simple toast component)

### Task 4: Add toast notification system

**Options:**
- `sonner` (lightweight, popular) — `bun add sonner`
- Or build minimal toast with CSS animations

Toast types:
- Success: "Moved #262351 to B_107402_Redesign_Login/Logout"
- Error: "Failed to move mapping: <error message>"

**Files:**
- Modify: `src/clarity/ui/src/App.tsx` — add `<Toaster />` provider
- Use `toast.success()` / `toast.error()` in drag-and-drop handlers

---

## Enhancement 3: ADO Work Item Column Improvements

### Task 5: Work item type colors in mapping table

**Current:** ADO Work Item column shows plain text name + type badge
**New:** Add left border color from `WorkItemTypeColor` (same style as ExportTable)

### Task 6: Work item title as ADO link

**Current:** Plain text title
**New:** `<a href="https://{org}.visualstudio.com/{project}/_workitems/edit/{id}" target="_blank">`

Need `adoOrg` and `adoProject` from config — pass through to MappingTable.

### Task 7: Show Clarity code next to project name

**Current:** Code in separate column
**New:** Code on second line of Clarity project header: `262351_Release_Externí_Capex` on line 1, `00070705` in muted text on line 2

---

## Implementation Order

1. Task 1: Type extraction (foundation cleanup)
2. Task 2: Grouped mapping table (visual redesign)
3. Task 5-7: Column improvements (can be done with Task 2)
4. Task 4: Toast system
5. Task 3: Drag-and-drop (depends on Tasks 2 + 4)

## Dependencies

- `@dnd-kit/core` + `@dnd-kit/sortable` (or native DnD)
- `sonner` (toast)
