/**
 * Diff two `see` snapshots of the same window so an agent reads only what moved.
 *
 * Element indexes are positional and shift whenever the tree changes, so rows are aligned by
 * a structural signature (depth, role, identifier, title, description, subrole) with a longest
 * common subsequence over pre-order, the way Sky diffs against its previous tree revision.
 * Aligned rows are then compared field by field.
 */

export type SnapshotRow = Record<string, unknown> & { index: number; depth: number; role: string };

export interface FieldChange {
    from: unknown;
    to: unknown;
}

export interface ChangedRow {
    index: number;
    previousIndex: number;
    role: string;
    fields: Record<string, FieldChange>;
}

export interface SnapshotDiff {
    /** rows present now that had no counterpart before; full rows, they are new information */
    added: SnapshotRow[];
    /** rows that vanished; only their identity, the caller already saw them */
    removed: Array<Pick<SnapshotRow, "index" | "depth" | "role"> & { label?: string }>;
    changed: ChangedRow[];
    unchanged: number;
    /** current index for every previous index that survived, for callers holding old references */
    indexMap: Record<number, number>;
}

const SIGNATURE_KEYS = ["depth", "role", "AXIdentifier", "AXTitle", "AXDescription", "AXSubrole"] as const;
const IGNORED_KEYS = new Set(["index"]);

function signature(row: SnapshotRow): string {
    return SIGNATURE_KEYS.map((key) => String(row[key] ?? "")).join("\0");
}

function label(row: SnapshotRow): string | undefined {
    for (const key of ["AXTitle", "AXDescription", "AXIdentifier", "AXValue"] as const) {
        const value = row[key];
        if (typeof value === "string" && value !== "") {
            return value;
        }
    }

    return undefined;
}

function same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => same(item, b[i]));
    }

    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
        const left = a as Record<string, unknown>;
        const right = b as Record<string, unknown>;
        const keys = Object.keys(left);
        return (
            keys.length === Object.keys(right).length &&
            keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
        );
    }
    return a === b;
}

const MAX_LCS_MATRIX_CELLS = 65_536;

type AlignmentRange = {
    previous: string[];
    current: string[];
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
};

/** Find where the original diagonal-first, skip-old-on-tie path crosses the middle row. */
function middleCrossing({ previous, current, oldStart, oldEnd, newStart, newEnd }: AlignmentRange): number {
    const middle = oldStart + Math.floor((oldEnd - oldStart) / 2);
    const width = newEnd - newStart;
    let below = new Uint32Array(width + 1);
    let row = new Uint32Array(width + 1);
    for (let i = oldEnd - 1; i >= middle; i--) {
        for (let j = width - 1; j >= 0; j--) {
            row[j] = previous[i] === current[newStart + j] ? below[j + 1] + 1 : Math.max(below[j], row[j + 1]);
        }
        [below, row] = [row, below];
    }
    let crossings = Uint32Array.from({ length: width + 1 }, (_, j) => j);
    let nextCrossings = new Uint32Array(width + 1);
    for (let i = middle - 1; i >= oldStart; i--) {
        nextCrossings[width] = width;
        for (let j = width - 1; j >= 0; j--) {
            if (previous[i] === current[newStart + j]) {
                row[j] = below[j + 1] + 1;
                nextCrossings[j] = crossings[j + 1];
            } else if (below[j] >= row[j + 1]) {
                row[j] = below[j];
                nextCrossings[j] = crossings[j];
            } else {
                row[j] = row[j + 1];
                nextCrossings[j] = nextCrossings[j + 1];
            }
        }
        [below, row] = [row, below];
        [crossings, nextCrossings] = [nextCrossings, crossings];
    }
    return newStart + crossings[0];
}

/** Exact reconstruction with four linear rows. Halving the old range bounds recursion to 32 levels. */
function alignLinear(range: AlignmentRange, pairs: Array<[number, number]>): void {
    const { previous, current, oldStart, oldEnd, newStart, newEnd } = range;
    if (oldStart === oldEnd || newStart === newEnd) {
        return;
    }

    if (oldEnd - oldStart === 1) {
        for (let j = newStart; j < newEnd; j++) {
            if (previous[oldStart] === current[j]) {
                pairs.push([oldStart, j]);
                return;
            }
        }
        return;
    }

    const split = middleCrossing(range);
    const middle = oldStart + Math.floor((oldEnd - oldStart) / 2);
    alignLinear({ ...range, oldEnd: middle, newEnd: split }, pairs);
    alignLinear({ ...range, oldStart: middle, newStart: split }, pairs);
}

/** Longest common subsequence over signatures; returns aligned (previous, current) index pairs. */
function align(previous: string[], current: string[]): Array<[number, number]> {
    const prefix: Array<[number, number]> = [];
    let start = 0;
    while (start < previous.length && start < current.length && previous[start] === current[start]) {
        prefix.push([start, start]);
        start++;
    }
    const counts = (values: string[]) => {
        const result = new Map<string, number>();
        for (const value of values.slice(start)) {
            result.set(value, (result.get(value) ?? 0) + 1);
        }
        return result;
    };
    const oldCounts = counts(previous);
    const newCounts = counts(current);
    const suffix: Array<[number, number]> = [];
    let oldEnd = previous.length;
    let newEnd = current.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        previous[oldEnd - 1] === current[newEnd - 1] &&
        oldCounts.get(previous[oldEnd - 1]) === 1 &&
        newCounts.get(current[newEnd - 1]) === 1
    ) {
        suffix.push([--oldEnd, --newEnd]);
    }
    const rows = oldEnd - start;
    const cols = newEnd - start;
    const shared = new Set(current.slice(start, newEnd));
    if (!previous.slice(start, oldEnd).some((value) => shared.has(value))) {
        return [...prefix, ...suffix.reverse()];
    }

    if ((rows + 1) * (cols + 1) > MAX_LCS_MATRIX_CELLS) {
        alignLinear({ previous, current, oldStart: start, oldEnd, newStart: start, newEnd }, prefix);
        return [...prefix, ...suffix.reverse()];
    }
    const table: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            table[i][j] =
                previous[start + i] === current[start + j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
        if (previous[start + i] === current[start + j]) {
            prefix.push([start + i++, start + j++]);
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return [...prefix, ...suffix.reverse()];
}

export function diffSnapshots(previous: SnapshotRow[], current: SnapshotRow[]): SnapshotDiff {
    const pairs = align(previous.map(signature), current.map(signature));
    const matchedPrevious = new Set<number>();
    const matchedCurrent = new Set<number>();
    const changed: ChangedRow[] = [];
    const indexMap: Record<number, number> = {};
    let unchanged = 0;

    for (const [pi, ci] of pairs) {
        matchedPrevious.add(pi);
        matchedCurrent.add(ci);
        const before = previous[pi];
        const after = current[ci];
        indexMap[before.index] = after.index;
        const fields: Record<string, FieldChange> = {};

        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (IGNORED_KEYS.has(key) || same(before[key], after[key])) {
                continue;
            }

            fields[key] = { from: before[key], to: after[key] };
        }

        if (Object.keys(fields).length === 0) {
            unchanged++;
        } else {
            changed.push({ index: after.index, previousIndex: before.index, role: after.role, fields });
        }
    }

    const added = current.filter((_, ci) => !matchedCurrent.has(ci));
    const removed = previous
        .filter((_, pi) => !matchedPrevious.has(pi))
        .map((row) => ({ index: row.index, depth: row.depth, role: row.role, label: label(row) }));

    return { added, removed, changed, unchanged, indexMap };
}
