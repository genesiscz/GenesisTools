import { parsePatch, type StructuredPatch, structuredPatch } from "diff";
import { useMemo } from "react";

/**
 * Line diffs for "show me the change": before/after strings, or a unified
 * patch (`git diff` output), unified or side by side. Built on the `diff`
 * package's structured patches; no highlighter, so a line is one tone and the
 * tones mean what they mean elsewhere (ok added, err removed).
 */

export type DiffRowKind = "ctx" | "add" | "del";

export interface DiffRow {
    kind: DiffRowKind;
    text: string;
    oldNo?: number;
    newNo?: number;
}

export interface DiffHunk {
    header: string;
    rows: DiffRow[];
}

export interface DiffFile {
    name: string;
    hunks: DiffHunk[];
    added: number;
    removed: number;
}

/** Flatten a structured patch into numbered rows per hunk. */
export function diffFileFromPatch(patch: StructuredPatch): DiffFile {
    let added = 0;
    let removed = 0;
    const hunks = patch.hunks.map((hunk): DiffHunk => {
        let oldNo = hunk.oldStart;
        let newNo = hunk.newStart;
        const rows: DiffRow[] = [];

        for (const line of hunk.lines) {
            const mark = line[0];
            const text = line.slice(1);

            if (mark === "+") {
                rows.push({ kind: "add", text, newNo: newNo++ });
                added += 1;
            } else if (mark === "-") {
                rows.push({ kind: "del", text, oldNo: oldNo++ });
                removed += 1;
            } else if (mark !== "\\") {
                rows.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
            }
        }

        return {
            header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            rows,
        };
    });
    const oldName = patch.oldFileName ?? "";
    const newName = patch.newFileName ?? "";
    const name = oldName === newName || !oldName ? newName : `${oldName} → ${newName}`;

    return { name, hunks, added, removed };
}

export interface DiffSplitRow {
    left?: DiffRow;
    right?: DiffRow;
}

/** Pair removed lines with the added lines that replace them, for side-by-side rendering. */
export function pairDiffRows(rows: DiffRow[]): DiffSplitRow[] {
    const out: DiffSplitRow[] = [];
    let i = 0;

    while (i < rows.length) {
        const row = rows[i];

        if (row.kind === "ctx") {
            out.push({ left: row, right: row });
            i += 1;
            continue;
        }

        const dels: DiffRow[] = [];
        const adds: DiffRow[] = [];

        while (i < rows.length && rows[i].kind === "del") {
            dels.push(rows[i]);
            i += 1;
        }

        while (i < rows.length && rows[i].kind === "add") {
            adds.push(rows[i]);
            i += 1;
        }

        for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
            out.push({ left: dels[k], right: adds[k] });
        }
    }

    return out;
}

export interface DiffViewProps {
    before?: string;
    after?: string;
    /** A unified diff (`git diff` output) instead of before/after; may hold several files. */
    patch?: string;
    mode?: "unified" | "split";
    /** Column labels, e.g. ["HEAD", "working tree"]. Also the file names when diffing before/after. */
    labels?: [string, string];
    /** Unchanged lines kept around each change when diffing before/after (default 3). */
    context?: number;
    title?: string;
    /** Soft-wrap long lines instead of scrolling horizontally. */
    wrap?: boolean;
}

const ROW_CLASS: Record<DiffRowKind, string> = {
    ctx: "text-ink/80",
    add: "bg-ok/10 text-ok",
    del: "bg-err/10 text-err",
};

const MARK: Record<DiffRowKind, string> = { ctx: " ", add: "+", del: "-" };

const GUTTER = "w-10 select-none border-r border-line/60 px-1.5 text-right text-dim/70";

function Cell({ row, wrap, empty }: { row?: DiffRow; wrap: boolean; empty?: boolean }) {
    if (!row) {
        return <td className={`${empty ? "bg-panel/40" : ""} px-2`} colSpan={2} />;
    }

    return (
        <>
            <td className={GUTTER}>{row.kind === "add" ? row.newNo : row.oldNo}</td>
            <td className={`px-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"} ${ROW_CLASS[row.kind]}`}>
                <span className="mr-2 inline-block w-3 select-none opacity-70">{MARK[row.kind]}</span>
                {row.text || " "}
            </td>
        </>
    );
}

function UnifiedTable({ file, wrap }: { file: DiffFile; wrap: boolean }) {
    return (
        <table className="w-full border-collapse font-mono text-[0.78rem] leading-relaxed">
            <tbody>
                {file.hunks.map((hunk, h) => (
                    <HunkRows key={`${hunk.header}-${h}`} hunk={hunk} wrap={wrap} />
                ))}
            </tbody>
        </table>
    );
}

function HunkRows({ hunk, wrap }: { hunk: DiffHunk; wrap: boolean }) {
    return (
        <>
            <tr>
                <td colSpan={3} className="bg-panel px-2 py-0.5 text-dim">
                    {hunk.header}
                </td>
            </tr>
            {hunk.rows.map((row, i) => (
                <tr key={`${row.kind}-${row.oldNo ?? ""}-${row.newNo ?? ""}-${i}`} className={ROW_CLASS[row.kind]}>
                    <td className={GUTTER}>{row.oldNo ?? ""}</td>
                    <td className={GUTTER}>{row.newNo ?? ""}</td>
                    <td className={`px-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
                        <span className="mr-2 inline-block w-3 select-none opacity-70">{MARK[row.kind]}</span>
                        {row.text || " "}
                    </td>
                </tr>
            ))}
        </>
    );
}

function SplitTable({ file, wrap, labels }: { file: DiffFile; wrap: boolean; labels?: [string, string] }) {
    return (
        <table className="w-full table-fixed border-collapse font-mono text-[0.78rem] leading-relaxed">
            {labels ? (
                <thead>
                    <tr className="bg-panel text-dim">
                        <th colSpan={2} className="px-2 py-1 text-left font-normal">
                            {labels[0]}
                        </th>
                        <th colSpan={2} className="border-l border-line px-2 py-1 text-left font-normal">
                            {labels[1]}
                        </th>
                    </tr>
                </thead>
            ) : null}
            <tbody>
                {file.hunks.map((hunk, h) => (
                    <SplitHunkRows key={`${hunk.header}-${h}`} hunk={hunk} wrap={wrap} />
                ))}
            </tbody>
        </table>
    );
}

function SplitHunkRows({ hunk, wrap }: { hunk: DiffHunk; wrap: boolean }) {
    const pairs = useMemo(() => pairDiffRows(hunk.rows), [hunk.rows]);

    return (
        <>
            <tr>
                <td colSpan={4} className="bg-panel px-2 py-0.5 text-dim">
                    {hunk.header}
                </td>
            </tr>
            {pairs.map((pair, i) => (
                <tr key={`${pair.left?.oldNo ?? ""}-${pair.right?.newNo ?? ""}-${i}`}>
                    <Cell row={pair.left} wrap={wrap} empty />
                    <Cell row={pair.right} wrap={wrap} empty />
                </tr>
            ))}
        </>
    );
}

/** Line diff, unified or side by side, from before/after strings or a unified patch. */
export function DiffView({
    before,
    after,
    patch,
    mode = "unified",
    labels,
    context = 3,
    title,
    wrap = false,
}: DiffViewProps) {
    const files = useMemo((): DiffFile[] => {
        if (patch !== undefined) {
            return parsePatch(patch).map(diffFileFromPatch);
        }

        const [oldName, newName] = labels ?? ["before", "after"];

        return [
            diffFileFromPatch(
                structuredPatch(oldName, newName, before ?? "", after ?? "", undefined, undefined, { context })
            ),
        ];
    }, [before, after, patch, labels, context]);
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const showNames = patch !== undefined || Boolean(title);

    return (
        <div className="my-3 overflow-hidden rounded-card border border-line">
            <div className="flex items-center justify-between gap-3 border-b border-line bg-panel px-3 py-1 font-mono text-[0.72rem] text-dim">
                <span>{title ?? (files.length === 1 && !patch ? `${files[0].name}` : "diff")}</span>
                <span>
                    <span className="text-ok">+{added}</span> <span className="text-err">-{removed}</span>
                </span>
            </div>
            {added + removed === 0 ? (
                <div className="px-3 py-2 text-sm text-dim">no changes</div>
            ) : (
                files.map((file, i) => (
                    <div key={`${file.name}-${i}`} className="overflow-x-auto">
                        {showNames && patch !== undefined ? (
                            <div className="border-b border-line/60 bg-canvas/60 px-3 py-1 font-mono text-[0.72rem] text-ink/80">
                                {file.name}
                            </div>
                        ) : null}
                        {mode === "split" ? (
                            <SplitTable file={file} wrap={wrap} labels={labels} />
                        ) : (
                            <UnifiedTable file={file} wrap={wrap} />
                        )}
                    </div>
                ))
            )}
        </div>
    );
}
