# `src/utils/opentui/components/` — design

Reusable, domain-agnostic OpenTUI building blocks for any Bun/Solid TUI in this repo. Doctor is the first consumer; other future TUIs (for `tools tickets`, `tools timelog`, etc.) import the same primitives.

Everything here wraps `@opentui/core` imperative classes behind a Solid component API so callers don't `extend({...})` ad-hoc, don't scatter `@ts-expect-error`, and get a consistent keyboard/selection/cursor story.

---

## Principles

1. **Dumb display + lifted state.** Components don't own navigation state; they take `cursor`, `selected`, etc. as props and emit `onCursorChange` / `onToggle`. The parent owns the signals. This matches how `Select` / `FindingsDrawer` already work.
2. **Generic over row type.** `<Table<T>>` takes `rows: T[]` and `columns: ColumnSpec<T>[]` where a column specifies `render: (row) => Cell`. No stringly-typed cells at the call site.
3. **One opentui `extend()` per module, at module top-level** — not scattered in app code. Each component file extends the catalogue once and exports a wrapped Solid component.
4. **Styling via props, not global theme.** Accept `theme?: TableTheme` with sensible defaults. Callers can pass their project theme object. Keeps `src/utils/` decoupled from `src/doctor/ui/tui/theme.ts`.
5. **JSX types shipped alongside the component.** Every component that calls `extend()` also augments `OpenTUIComponents` in a `.d.ts` in the same folder so importing the component silently enables its JSX tag in TypeScript.
6. **No React imports. No ink imports.** Solid only.

---

## Directory layout

```
src/utils/opentui/
    components/
        DESIGN.md                     // this file
        index.ts                      // re-exports every component + types
        table/
            Table.tsx                 // <Table> — the main primitive
            types.ts                  // TableColumn, TableTheme, Cell, CellChunk
            helpers.ts                // padLeft, padRight, truncateLeft, truncateRight, formatAge
            jsx.d.ts                  // augments OpenTUIComponents with text_table
            __tests__/Table.test.tsx
        status-strip/
            StatusStrip.tsx           // non-interactive label/value list (pairs with Table)
            types.ts                  // StatusRow
        badge/
            Badge.tsx                 // <Badge color="...">■</Badge> one-char marker
        checkbox/
            CheckboxCell.tsx          // renders [x] / [ ] / [-] as a Cell
        key-help/
            KeyHelp.tsx               // <KeyHelp hints={[{key:"j/k", label:"move"}, ...]} />
        scroll-list/
            ScrollList.tsx            // simpler single-column list selector wrapping Table
        split-view/
            SplitView.tsx             // left/right panels with focus tracking
    hooks/
        useCursor.ts                  // [cursor, setCursor, bind(keys)] — j/k/up/down helper
        useListSelection.ts           // [selectedIds, toggle, clear] set-selection helper
    themes/
        default-theme.ts              // reasonable defaults used when caller passes none
```

Only `table/`, `status-strip/`, `badge/`, `checkbox/`, and `key-help/` need to land for doctor to migrate. `scroll-list`, `split-view`, and the hooks can follow.

---

## Types

```ts
// src/utils/opentui/components/table/types.ts
import type { JSX } from "@opentui/solid";

export interface CellChunk {
    text: string;
    fg?: string;
    bg?: string;
    bold?: boolean;
}
export type Cell = CellChunk[];

export interface TableColumn<T> {
    /** Header text for the column. */
    header: string;
    /** How to render a row's cell for this column. */
    render: (row: T, ctx: RowRenderContext) => Cell;
    /** Flex weight when columnWidthMode is "fill"; 0 = content-sized. */
    weight?: number;
    /** Right-align the column. Implemented by padding in render; no real prop in core. */
    align?: "left" | "right";
    /** Optional column id for testing / keyboard jumping. */
    id?: string;
}

export interface RowRenderContext {
    /** True when this row is the current cursor target. */
    isCursor: boolean;
    /** True when this row is selected. */
    isSelected: boolean;
    /** Row's index within the rendered slice (not the full rows array). */
    index: number;
}

export interface TableTheme {
    fg: string;
    fgDim: string;
    bgHighlight: string;      // cursor row bg
    bgHeader: string;          // header row bg
    selectedFg: string;
    blockedFg: string;
}

export interface TableProps<T> {
    rows: T[];
    columns: TableColumn<T>[];
    /** Index of the current cursor row (in `rows`). Required — Table is a controlled component. */
    cursor: number;
    /** Rows selected by id. When provided, the table renders a sel column automatically. */
    selectedIds?: Set<string>;
    getRowId?: (row: T) => string;
    isBlocked?: (row: T) => boolean;
    /** Show header row. Default true. */
    showHeader?: boolean;
    /** Pre-computed viewport size (rows excluding header). Default: infer from parent height. */
    viewportRows?: number;
    /** Optional theme override. */
    theme?: Partial<TableTheme>;
    /** Style the table's surrounding <box>. */
    style?: { border?: boolean; borderStyle?: "single" | "rounded" | "double" };
    /** Emitted when selected set should change. Parent is expected to flip the set. */
    onToggle?: (rowId: string) => void;
    /** Emitted when cursor moves via built-in j/k/up/down keys; if omitted, keyboard is NOT bound. */
    onCursorChange?: (nextCursor: number) => void;
}

export function Table<T>(props: TableProps<T>): JSX.Element;
```

Key design decisions:
- **Selection is optional.** When `selectedIds` is omitted, no checkbox column is rendered. `securityView` (pure status display) relies on this.
- **Keyboard is opt-in.** Pass `onCursorChange` to enable j/k/up/down inside the component; omit to handle keys in the parent. Doctor's drawer passes both.
- **`blocked` is orthogonal to selection.** `isBlocked(row)` keeps it from being toggleable and renders `[-]`.

---

## `<Table>` render contract

Pseudo-implementation (actual code in `Table.tsx`):

```tsx
import { TextTableRenderable } from "@opentui/core";
import { extend } from "@opentui/solid";
import { createMemo } from "solid-js";

extend({ text_table: TextTableRenderable });

export function Table<T>(props: TableProps<T>) {
    const theme = { ...DEFAULT_THEME, ...props.theme };

    // 1) Derive visible slice around cursor (avoid mounting 10k rows).
    const slice = createMemo(() => sliceAroundCursor(props.rows, props.cursor, props.viewportRows ?? 20));

    // 2) Build TextTableContent. Insert a sel column up front when selectedIds provided.
    const content = createMemo(() => {
        const cols = props.selectedIds ? [selColumn<T>(props, theme), ...props.columns] : props.columns;
        const header = cols.map(col => [{ text: col.header, fg: theme.fgDim, bg: theme.bgHeader, bold: true }]);
        const body = slice().rows.map((row, i) => {
            const absoluteIndex = slice().startIndex + i;
            const ctx: RowRenderContext = {
                isCursor: absoluteIndex === props.cursor,
                isSelected: props.selectedIds?.has(props.getRowId!(row)) ?? false,
                index: i,
            };
            const rowBg = ctx.isCursor ? theme.bgHighlight : undefined;
            return cols.map(col => applyBg(col.render(row, ctx), rowBg));
        });
        return [header, ...body];
    });

    // 3) Bind keyboard if onCursorChange provided.
    if (props.onCursorChange) {
        useKeyboard((key) => {
            if (key.name === "j" || key.name === "down") props.onCursorChange!(Math.min(props.cursor + 1, props.rows.length - 1));
            else if (key.name === "k" || key.name === "up") props.onCursorChange!(Math.max(0, props.cursor - 1));
            else if (key.name === "space" && props.selectedIds && props.onToggle) {
                const row = props.rows[props.cursor];
                if (row && props.getRowId && !(props.isBlocked?.(row) ?? false)) {
                    props.onToggle(props.getRowId(row));
                }
            }
        });
    }

    return (
        <text_table
            content={content()}
            wrapMode="none"
            columnWidthMode="fill"
            columnFitter="balanced"
            border={false}
            outerBorder={props.style?.border ?? false}
            borderStyle={props.style?.borderStyle}
            cellPadding={0}
            flexGrow={1}
        />
    );
}
```

`selColumn()`, `applyBg()`, and `sliceAroundCursor()` live in `helpers.ts`.

---

## `<Badge>`

Trivial:

```tsx
export interface BadgeProps { color: string; children?: string; }
export const Badge = (p: BadgeProps) => (
    <span fg={p.color}>{p.children ?? "■"}</span>
);
```

Used by callers when they want a severity dot in a regular `<text>` line (outside a Table cell).

---

## `<CheckboxCell>`

Exports a function that returns a `Cell` (not a component) — tables want cells, not JSX. Naming convention: **components** return JSX, **cell factories** return `Cell`. Both live here.

```ts
export function checkboxCell(state: "on" | "off" | "blocked", theme: TableTheme): Cell {
    if (state === "blocked") return [{ text: "[-]", fg: theme.blockedFg }];
    if (state === "on") return [{ text: "[x]", fg: theme.selectedFg }];
    return [{ text: "[ ]", fg: theme.fgDim }];
}
```

---

## `<StatusStrip>`

Non-interactive label/value list for read-only diagnostics. Pairs with `<Table>` for the "Status + Actionable" split pattern. Used when findings have no actions — you must not give the user a checkbox for something they can't act on.

```ts
// src/utils/opentui/components/status-strip/StatusStrip.tsx
export interface StatusRow {
    label: string;
    value: string;
    valueFg?: string;                     // override color; e.g. red for "HIGH" pressure
    tone?: "normal" | "warn" | "danger";  // semantic alternative to valueFg
}

export interface StatusStripProps {
    rows: StatusRow[];
    /** Muted label color. Default: theme.fgDim. */
    labelFg?: string;
    /** Show nothing when rows is empty. Default true; pass false to render an empty container for layout stability. */
    hideIfEmpty?: boolean;
}

export function StatusStrip(props: StatusStripProps): JSX.Element | null;
```

Implementation is trivial (label-padded two-column render with no cursor/keyboard). Labels are left-padded to the longest label width in the row set so the values align visually without any flexbox magic.

**When to use:**
- Analyzer output is diagnostic (battery cycle count, security toggles, swap usage) — no actions attached.
- Header summaries that must not be interactive.

**When NOT to use:**
- Any case where the user should be able to select or drill into a row — use `<Table>` with `selectedIds` omitted instead; it still renders a cursor.

**Drawer composition pattern:**

```tsx
<box flexDirection="column">
    <DrawerHeader />
    <StatusStrip rows={view().status} />
    {actionableCount() > 0
        ? <Table<Finding> rows={view().actionable.findings} ... />
        : <EmptyActionable />}
    <KeyHelp hints={...} />
</box>
```

---

## `<KeyHelp>`

```tsx
export interface KeyHint { key: string; label: string; }
export interface KeyHelpProps { hints: KeyHint[]; }

export const KeyHelp = (p: KeyHelpProps) => (
    <text>
        {p.hints.map((h, i) => (
            <>
                {i > 0 && <span fg="#555">  </span>}
                <span fg="#7aa2f7">[{h.key}]</span>
                <span fg="#888"> {h.label}</span>
            </>
        ))}
    </text>
);
```

Used at the bottom of `FindingsDrawer` and elsewhere to render the key legend consistently.

---

## `<ScrollList<T>>`

A thin wrapper around `<Table>` for the single-column case:

```tsx
export function ScrollList<T>(props: {
    items: T[];
    renderItem: (item: T, ctx: RowRenderContext) => Cell;
    cursor: number;
    onCursorChange: (i: number) => void;
}) {
    return <Table<T>
        rows={props.items}
        cursor={props.cursor}
        onCursorChange={props.onCursorChange}
        columns={[{ header: "", render: props.renderItem, weight: 1 }]}
        showHeader={false}
    />;
}
```

---

## `<SplitView>`

For drill-in / master-detail layouts (future — not needed for the current doctor redesign):

```tsx
<SplitView direction="row" split={0.4}
    left={<ScrollList … />}
    right={<DetailPanel … />}
    focus={focus()}
    onFocusChange={setFocus}
/>
```

Tab/shift-tab moves focus between panels; `focus` determines which panel receives keys.

---

## Hooks

```ts
// useCursor — canonical j/k/up/down cursor state.
export function useCursor(opts: { count: () => number; initial?: number }): {
    cursor: Accessor<number>;
    setCursor: (n: number) => void;
    bindKeys: () => void;  // call inside a component body to activate
};

// useListSelection — Set<id> selection with toggle/clear.
export function useListSelection(): {
    selected: Accessor<Set<string>>;
    toggle: (id: string) => void;
    clear: () => void;
    has: (id: string) => boolean;
};
```

Doctor's `engine-store` already owns selection; it doesn't need `useListSelection`. The hook is for new TUIs that don't have a zustand store.

---

## Example end-to-end usage (doctor's FindingsDrawer rewritten against these primitives)

```tsx
import { Table, StatusStrip, KeyHelp } from "@app/utils/opentui/components";
import type { Finding } from "@app/doctor/lib/types";
import { viewForAnalyzer } from "./views";

export function FindingsDrawer(props: { analyzerId: string; findings: Finding[]; onClose: () => void }) {
    const [cursor, setCursor] = createSignal(0);
    const selectedFindingIds = useStore(useEngineStore, (s) => s.selectedFindingIds);

    const view = createMemo(() => viewForAnalyzer(props.analyzerId)(props.findings));

    useKeyboard((key) => {
        if (key.name === "escape" || key.name === "q") props.onClose();
    });

    return (
        <box flexDirection="column" border borderStyle="rounded" padding={1} flexGrow={1}>
            <DrawerHeader
                analyzerId={props.analyzerId}
                actionableCount={view().actionable.findings.length}
                statusCount={view().status.length}
                selected={selectedFindingIds()}
            />

            <StatusStrip rows={view().status} />

            {view().actionable.findings.length > 0 ? (
                <Table<Finding>
                    rows={view().actionable.findings}
                    cursor={cursor()}
                    onCursorChange={setCursor}
                    selectedIds={selectedFindingIds()}
                    getRowId={(f) => f.id}
                    isBlocked={(f) => f.severity === "blocked" || f.actions.length === 0}
                    onToggle={(id) => useEngineStore.getState().toggleFinding(id)}
                    columns={view().actionable.columns}
                    theme={{ bgHighlight: "#2a2f4a" }}
                />
            ) : (
                <EmptyActionable />
            )}

            <KeyHelp hints={[
                { key: "j/k", label: "move" },
                { key: "space", label: "toggle" },
                { key: "x", label: "act" },
                { key: "esc", label: "close" },
            ]} />
        </box>
    );
}
```

Note the shift:
- The **view** now returns `{ status: StatusRow[], actionable: { columns: TableColumn<Finding>[], findings: Finding[] } }` — pre-split into the two zones. Views stay pure and trivially unit-testable.
- `<Table>` does the slicing, cursor highlighting, selection column, and keyboard. It only ever sees actionable findings — never status.
- `<StatusStrip>` handles the non-interactive zone, is rendered above the table, and never reacts to keyboard input.
- `isBlocked` is extended to include `actions.length === 0` as a safety net in case a status-y finding leaks into the actionable zone; its checkbox still renders `[-]` and `[space]` is ignored.

This replaces the `ViewFn → ViewResult { columns, rows, total }` design in `2026-04-17-MacOSDoctor.REDESIGN-DrawerTables.md`. The redesign plan should be updated to: views export `TableColumn<Finding>[]` (or a `(findings: Finding[]) => TableColumn<Finding>[]` factory if the column set is data-dependent).

---

## Migration plan (keeps doctor moving, extracts reuse later)

Two-pass strategy so we don't block the user-visible fix:

**Pass 1 — land doctor fix in the simpler form** (per `2026-04-17-MacOSDoctor.REDESIGN-DrawerTables.md`)
- `src/doctor/ui/tui/views/*` owns everything including the table rendering.
- No `src/utils/opentui/` yet.
- Doctor user sees the improved drawer *today*.

**Pass 2 — extract to `src/utils/opentui/components/`** (separate branch / PR)
- Create `Table`, `CheckboxCell`, `Badge`, `KeyHelp` in `src/utils/opentui/components/` with no behaviour change.
- Migrate doctor's `FindingsDrawer` to use them.
- Delete the doctor-local duplicates.
- Each subsequent TUI (tickets, timelog, etc.) adopts these directly.

The two passes are independent; pass 2 can be shaved to a single commit per component once the design is stable. **If time allows, skip pass 1 and go straight to pass 2** — it's only marginally more work and leaves the repo in a better place.

---

## Testing

- `Table.test.tsx` — uses `testRender` from `@opentui/solid`, captures `captureCharFrame()`, asserts the header row, cursor highlight, and selection column appear for a representative set of columns.
- `helpers.test.ts` — pure functions (`padLeft`, `truncateLeft`, `formatAge`, `sliceAroundCursor`), quick wins.
- Each doctor view gets a unit test that asserts the shape of `TableColumn<Finding>[]` and the `render()` output for a representative finding (already in the other plan).

No snapshot bitmap testing — use `captureCharFrame()` + substring assertions to stay resilient to minor styling changes.

---

## JSX types

Each component that calls `extend({...})` ships a sibling `.d.ts`:

```ts
// src/utils/opentui/components/table/jsx.d.ts
import type { TextTableOptions } from "@opentui/core";

declare module "@opentui/solid" {
    interface OpenTUIComponents {
        text_table: TextTableOptions;
    }
}
```

Importing the component (directly or via `src/utils/opentui/components/index.ts`) pulls the augmentation in — no `@ts-expect-error` at callsites.

---

## Open questions (flag during implementation)

1. Should `Table` accept `onAction?: (row: T) => void` for Enter-to-act shortcut? Doctor currently has global `x` for selected findings — but drill-in views elsewhere (tickets) will want per-row action.
2. Can we share a single `<ScrollBox>` pattern for tables bigger than the viewport rather than slicing in userland? See `2026-04-17-MacOSDoctor.REDESIGN-DrawerTables.md` §"Library cheat sheet" — scrollbox + focus conflicts with our j/k binding. Worth a follow-up investigation once `Table` stabilises.
3. Multi-column keyboard jump (e.g. left/right to move between columns for inline editing)? Out of scope for v1, add `onColumnChange` later if needed.
