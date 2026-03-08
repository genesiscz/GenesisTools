# Grouped Mapping Table with Drag-and-Drop

## Context

The "Configured Mappings" section on the Mappings page currently shows a flat table. The user wants:
1. **Grouped by Clarity project** — one card per project, with all mapped ADO work items inside
2. **Drag-and-drop** — drag an ADO work item row from one Clarity group to another (fires API, shows toast)
3. **ADO work item column** — show type color badge (same pattern as ExportTable), title as link to ADO, work item ID
4. **Clarity project code** — show on second line of the group header

---

## Task 1: Install `sonner` and add Toaster to App

**Files:**
- Modify: `src/clarity/ui/package.json` — `bun add sonner`
- Modify: `src/clarity/ui/src/App.tsx` — add `<Toaster>` from sonner after `<RouterProvider>`

Toaster config: `theme="dark"` with cyberpunk-matching styles (dark bg, amber border, mono font).

---

## Task 2: Add `moveMapping()` server function + API endpoint

**Files:**
- Modify: `src/clarity/ui/src/server/mappings.ts` — add `moveMapping(adoWorkItemId, target)`
- Modify: `src/clarity/ui/src/server/api-plugin.ts` — add `POST /api/move-mapping` route

`moveMapping()` finds the mapping by `adoWorkItemId`, replaces `clarityTask*` and `clarityInvestment*` fields with target group's values, saves config. Single atomic operation — no need for remove+add.

---

## Task 3: Extract `buildWorkItemUrl` to shared component

**Files:**
- Create: `src/clarity/ui/src/components/WorkItemLink.tsx`

Extract from `ExportTable.tsx:25` the `buildWorkItemUrl()` function and the link rendering pattern (lines 85-97) into a reusable component:

```tsx
// Reusable across MappingTable, ExportTable, AddMappingForm
export function buildWorkItemUrl(org: string, project: string, id: number): string {
    return `${org}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

export function WorkItemLink({ id, title, adoOrg, adoProject }: {
    id: number; title?: string; adoOrg?: string | null; adoProject?: string | null;
}) { ... }
```

Also extract the type badge inline style pattern into a helper:

```tsx
export function TypeBadge({ typeName, color }: { typeName: string; color?: WorkItemTypeColor }) { ... }
```

Uses the same ExportTable pattern: `borderLeft: 3px solid #${color}`, `backgroundColor: #${color}18`, `color: #${color}`.

Update `ExportTable.tsx` to import from `WorkItemLink.tsx` instead of defining locally.

---

## Task 4: Rewrite `MappingTable.tsx` with grouped layout + DnD

**Files:**
- Rewrite: `src/clarity/ui/src/components/MappingTable.tsx`

### New Props

```typescript
interface MappingTableProps {
    mappings: ClarityMapping[];
    typeColors: Record<string, WorkItemTypeColor>;
    adoOrg: string | null;
    adoProject: string | null;
    onRemove: (adoWorkItemId: number) => void;
    onMove: (adoWorkItemId: number, targetGroup: ClarityGroup) => void;
}
```

### Grouping

Group `mappings` by `clarityTaskId` into `ClarityGroup[]`. Each group has header + item list.

### Layout per group

```
┌─────────────────────────────────────────────────────────────────┐
│ 262351_Release_Externí_Capex                         3 items    │
│ 00070705 · Domain Project X                                    │
├─────────────────────────────────────────────────────────────────┤
│ ██ Release                              Task   #262351    ✕    │
│ ██ Deploy pipeline fix                  Bug    #267890    ✕    │
│ ██ Some other task                      Task   #270128    ✕    │
└─────────────────────────────────────────────────────────────────┘
```

- Group header: `clarityTaskName` on line 1, `clarityTaskCode · clarityInvestmentName` on line 2 (muted), item count badge
- Each row: type color left border, title as `<WorkItemLink>`, type badge via `<TypeBadge>`, `#id`, delete button
- Rows are `draggable`, groups are drop targets

### HTML5 Drag-and-Drop

- `onDragStart`: `e.dataTransfer.setData("text/plain", String(item.adoWorkItemId))`
- `onDragOver`: `e.preventDefault()` + set `dragOverGroupId` state for highlight
- `onDragLeave`: clear highlight
- `onDrop`: read work item ID, skip if same group, call `onMove(id, targetGroup)`
- Visual: drop target gets `border-amber-500/60 bg-amber-500/5` highlight
- Row gets `cursor-grab` / `active:cursor-grabbing`

---

## Task 5: Update `mappings.tsx` route — wire queries + mutations + toasts + swap order

**Files:**
- Modify: `src/clarity/ui/src/routes/mappings.tsx`

Add:
- `useQuery(["workitem-type-colors"])` → `GET /api/workitem-type-colors` (staleTime: 1h)
- `useQuery(["ado-config"])` → `GET /api/ado-config` (staleTime: 1h)
- `moveMutation` → `POST /api/move-mapping` with `onSuccess: toast.success(...)`, `onError: toast.error(...)`
- Update `removeMutation` to also show toast
- Pass `typeColors`, `adoOrg`, `adoProject`, `onMove` to `<MappingTable>`
- **Swap layout order**: Move "Add Mapping" form BELOW "Configured Mappings" (currently Add is above). Mappings table comes first since it's the primary view; Add is secondary action below.

---

## Implementation Order

1. Task 1 — sonner + Toaster (foundation)
2. Task 2 — moveMapping server + endpoint (backend)
3. Task 3 — extract WorkItemLink + TypeBadge (shared components)
4. Task 4 — rewrite MappingTable (main visual change)
5. Task 5 — wire route with queries/mutations/toasts

## Verification

1. Open `http://localhost:3071/#/mappings` in Feb 2026
2. See mappings grouped by Clarity project (cards)
3. Each card header shows project name + code on second line
4. Each ADO row shows: type color border, title as link, type badge, #ID, delete button
5. Drag a row from one group to another → toast "Mapping moved successfully"
6. Page refreshes showing the item in the new group
7. Delete a mapping → toast "Mapping removed"
8. Drag to same group → no action (no API call)
