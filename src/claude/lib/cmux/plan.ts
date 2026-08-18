import type {
    LayoutMode,
    PlannedPane,
    PlannedWorkspace,
    RestoreCandidate,
    RestorePlan,
} from "@app/claude/lib/cmux/types";
import type { SplitTree } from "@genesiscz/utils/cmux/split-tree";

export interface PlanOptions {
    layout: LayoutMode;
    /** Max panes in one workspace. Only meaningful for "capped" and "tabs". */
    perWorkspace: number;
    /** Group sessions by project, one workspace (or set of workspaces) each. */
    perProject: boolean;
    /** Force every pane onto this account, ignoring the recorded pin. */
    forceAccount?: string;
}

/**
 * Turn the picked sessions into workspaces of panes.
 *
 * - `capped` (default): even grid up to `perWorkspace` panes, the rest spilling into
 *   sibling workspaces. Nothing is hidden and no pane is squeezed below readable.
 * - `grid`: one workspace, every session a pane, however many. cmux clamps at its
 *   minimum pane size, so past ~8 panes the geometry stops converging.
 * - `tabs`: fill `perWorkspace` panes, then stack the remaining sessions as extra
 *   surfaces inside those panes. One workspace always, overflow behind tab switches.
 *
 * Session order is preserved throughout (the caller sorts by last activity), and with
 * `perProject` the projects themselves are ordered by their most recent session.
 */
export function buildRestorePlan(candidates: RestoreCandidate[], opts: PlanOptions): RestorePlan {
    if (candidates.length === 0) {
        return { workspaces: [] };
    }

    const groups = opts.perProject ? groupByProject(candidates) : [{ project: "claude", sessions: candidates }];
    const workspaces: PlannedWorkspace[] = [];

    for (const group of groups) {
        const chunks = chunkForLayout(group.sessions, opts);

        chunks.forEach((chunk, index) => {
            workspaces.push({
                title: chunks.length > 1 ? `${group.project} ${index + 1}` : group.project,
                cwd: chunk[0].cwd,
                panes: layPanes(chunk, opts),
            });
        });
    }

    return { workspaces };
}

interface ProjectGroup {
    project: string;
    sessions: RestoreCandidate[];
}

/** Projects in order of their most recent session; sessions keep their input order. */
function groupByProject(candidates: RestoreCandidate[]): ProjectGroup[] {
    const groups = new Map<string, RestoreCandidate[]>();

    for (const candidate of candidates) {
        const existing = groups.get(candidate.project);

        if (existing) {
            existing.push(candidate);
        } else {
            groups.set(candidate.project, [candidate]);
        }
    }

    return [...groups.entries()].map(([project, sessions]) => ({ project, sessions }));
}

/** Split one project's sessions into per-workspace chunks. */
function chunkForLayout(sessions: RestoreCandidate[], opts: PlanOptions): RestoreCandidate[][] {
    if (opts.layout !== "capped" || opts.perWorkspace <= 0 || sessions.length <= opts.perWorkspace) {
        return [sessions];
    }

    const chunks: RestoreCandidate[][] = [];

    for (let i = 0; i < sessions.length; i += opts.perWorkspace) {
        chunks.push(sessions.slice(i, i + opts.perWorkspace));
    }

    return chunks;
}

/** One pane per session, except in `tabs` mode where the overflow stacks round-robin. */
function layPanes(sessions: RestoreCandidate[], opts: PlanOptions): PlannedPane[] {
    const paneCount =
        opts.layout === "tabs" && opts.perWorkspace > 0
            ? Math.min(sessions.length, opts.perWorkspace)
            : sessions.length;
    const panes: PlannedPane[] = Array.from({ length: paneCount }, (_, paneIndex) => ({ paneIndex, sessions: [] }));

    sessions.forEach((candidate, index) => {
        panes[index % paneCount].sessions.push({
            candidate,
            account: opts.forceAccount ?? candidate.account,
            model: candidate.model,
        });
    });

    return panes;
}

/**
 * Rows per column for an even grid of `n` panes: as square as possible, and the
 * leftmost columns take the extra row when `n` doesn't divide evenly.
 */
export function gridShape(n: number): number[] {
    if (n <= 0) {
        return [];
    }

    const cols = Math.ceil(Math.sqrt(n));
    const base = Math.floor(n / cols);
    const extra = n % cols;

    return Array.from({ length: cols }, (_, col) => base + (col < extra ? 1 : 0));
}

/**
 * Grid cells in reading order: left to right along each row, top row first. Returns
 * `[column, row]` pairs, so cell k of the result holds pane index k. Columns can be
 * one row shorter than their neighbours, and those rows are simply skipped.
 */
export function readingOrderCells(shape: number[]): Array<[number, number]> {
    const maxRows = Math.max(0, ...shape);
    const cells: Array<[number, number]> = [];

    for (let row = 0; row < maxRows; row += 1) {
        for (let col = 0; col < shape.length; col += 1) {
            if (row < shape[col]) {
                cells.push([col, row]);
            }
        }
    }

    return cells;
}

/**
 * A binary split tree that lays `n` panes out as an even grid, with pane indices
 * assigned in reading order (top-left first). Columns are split off one at a time,
 * then each column is split into its rows — the fractions are exact, so cmux only
 * has to move each border once.
 */
export function buildGridTree(n: number): SplitTree {
    if (n <= 0) {
        throw new Error("A grid needs at least one pane");
    }

    const shape = gridShape(n);
    const cells = readingOrderCells(shape);
    const paneIndexByCell = new Map<string, number>();

    cells.forEach(([col, row], paneIndex) => {
        paneIndexByCell.set(`${col}:${row}`, paneIndex);
    });

    const column = (col: number): SplitTree => rowsTree(col, 0, shape[col], paneIndexByCell);

    const columnsTree = (from: number): SplitTree => {
        const remaining = shape.length - from;

        if (remaining === 1) {
            return column(from);
        }

        return {
            kind: "vsplit",
            left: column(from),
            right: columnsTree(from + 1),
            leftFraction: 1 / remaining,
        };
    };

    return columnsTree(0);
}

function rowsTree(col: number, from: number, rows: number, paneIndexByCell: Map<string, number>): SplitTree {
    const remaining = rows - from;
    const paneIndex = paneIndexByCell.get(`${col}:${from}`);

    if (paneIndex === undefined) {
        throw new Error(`Grid cell ${col}:${from} has no pane index`);
    }

    if (remaining === 1) {
        return { kind: "leaf", paneIndex };
    }

    return {
        kind: "hsplit",
        top: { kind: "leaf", paneIndex },
        bottom: rowsTree(col, from + 1, rows, paneIndexByCell),
        topFraction: 1 / remaining,
    };
}
