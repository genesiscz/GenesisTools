import type { ElementTable, EngineInterface, RenderElement } from "claude-code";
import { atom, read, update } from "claude-code";
import type { WholeDiffs } from "../types";
import { diffLines, foldedPatch } from "./sections";
import { isRecord } from "./settings";

// The line fold of the diff mod (`mods.diff.foldAfterLines`, 20). Claude Code draws a Write over an existing file and
// an Edit with every line of their diff (2026-11-25: a REPL script's write() over a 987-line TSV drew 1,974 lines),
// while it folds a new file to its first lines by itself. A diff past the limit draws its first lines and a
// `show all <n> lines` Button; open, it is the engine's own drawing with a `fold to <n> lines` Button under it. The
// mod's own diff blocks under a shell call fold each open file the same way (`drawDiffs` in register.tsx).

/**
 * The diffs the person opened past the limit: a Write or Edit row's `tool_use_id`, or a shell block's file key
 * (`fileKey`). Session state, so an open diff stays open through a redraw and a reload of the mod. The newest 500.
 */
export const wholeDiffs = atom({ plugin: "genesis-tools-mods", key: "whole" } as const, [] as WholeDiffs);

export async function openedDiffs($: EngineInterface): Promise<Set<string>> {
    return new Set(await read($, wholeDiffs));
}

export async function setWhole($: EngineInterface, key: string, isWhole: boolean): Promise<void> {
    await update($, wholeDiffs, (list) =>
        [...list.filter((item) => item !== key), ...(isWhole ? [key] : [])].slice(-500)
    );
}

/** `1,974`: a count with its thousands grouped. */
export function grouped(count: number): string {
    return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function showAllLabel(lines: number): string {
    return `show all ${grouped(lines)} lines`;
}

export function foldLabel(limit: number): string {
    return `fold to ${grouped(limit)} ${limit === 1 ? "line" : "lines"}`;
}

interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

function isHunk(value: unknown): value is Hunk {
    return (
        isRecord(value) &&
        typeof value.oldStart === "number" &&
        typeof value.oldLines === "number" &&
        typeof value.newStart === "number" &&
        typeof value.newLines === "number" &&
        Array.isArray(value.lines) &&
        value.lines.every((line) => typeof line === "string")
    );
}

/** What the engine draws under a Write or Edit row: the file, its hunks as one patch, and their line counts. */
export interface EditDiff {
    path: string;
    patch: string;
    added: number;
    removed: number;
    /** The lines the hunks draw, context included (`diffLines`). */
    lines: number;
}

/**
 * The diff of a Write over an existing file or of an Edit, from the stored result (`structuredPatch`). Undefined for a
 * new file (the engine folds it itself), a write held for review (drawn as a notice) and a result of another shape.
 */
export function editDiffOf(tool: string, output: unknown): EditDiff | undefined {
    if (!isRecord(output) || typeof output.filePath !== "string" || !Array.isArray(output.structuredPatch)) {
        return undefined;
    }

    if ((tool === "Write" && output.type !== "update") || output.staged === true) {
        return undefined;
    }

    const hunks = output.structuredPatch.filter(isHunk);
    const body = hunks.flatMap((hunk) => hunk.lines);
    const patch = hunks
        .map((hunk) =>
            [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join("\n")
        )
        .join("\n");

    return {
        path: output.filePath,
        patch,
        // As the engine counts them for its `Added 3 lines, removed 1 line`.
        added: body.filter((line) => line.startsWith("+")).length,
        removed: body.filter((line) => line.startsWith("-")).length,
        lines: diffLines(patch),
    };
}

/** The engine's own summary line, `Added 987 lines, removed 987 lines`, with the counts in bold as it draws them. */
function summaryOf(ui: ElementTable, diff: EditDiff): RenderElement {
    const { Text } = ui;
    const parts: (string | RenderElement)[] = [];

    if (diff.added > 0) {
        parts.push(
            "Added ",
            <Text key="added" bold>
                {String(diff.added)}
            </Text>,
            diff.added > 1 ? " lines" : " line"
        );
    }

    if (diff.removed > 0) {
        parts.push(
            diff.added > 0 ? ", removed " : "Removed ",
            <Text key="removed" bold>
                {String(diff.removed)}
            </Text>,
            diff.removed > 1 ? " lines" : " line"
        );
    }

    return <Text>{parts}</Text>;
}

/**
 * A Write or Edit result past the limit, folded: the engine's summary line under its `⎿`, the first `limit` lines of
 * the diff with Claude Code's own diff element, and `show all <n> lines` under them.
 */
export function foldedEdit(
    ui: ElementTable,
    row: { id: string; diff: EditDiff; limit: number; open: () => Promise<void> }
): RenderElement {
    const { Box, Button, Code, Text } = ui;

    return (
        <Box flexDirection="row">
            <Text dimColor>{"  ⎿  "}</Text>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                {summaryOf(ui, row.diff)}
                <Code source={foldedPatch(row.diff.patch, row.limit)} format="diff" path={row.diff.path} />
                <Button key={`${row.id}:lines`} dimColor onPress={row.open}>
                    {showAllLabel(row.diff.lines)}
                </Button>
            </Box>
        </Box>
    );
}

/** A Write or Edit result past the limit, open: the engine's own drawing, and `fold to <n> lines` under it. */
export function openEdit(
    ui: ElementTable,
    row: { id: string; limit: number; drawn: RenderElement; fold: () => Promise<void> }
): RenderElement {
    const { Box, Button } = ui;

    return (
        <Box flexDirection="column">
            {row.drawn}
            <Box flexDirection="row" paddingLeft={5}>
                <Button key={`${row.id}:lines`} dimColor onPress={row.fold}>
                    {foldLabel(row.limit)}
                </Button>
            </Box>
        </Box>
    );
}

/**
 * The engine draws a file of the session's scratchpad folder as its summary line alone, so the fold leaves those
 * rows to it. Asked only for a diff past the limit, and an answer of the engine's own: no process runs.
 */
export async function isInScratchpad($: EngineInterface, path: string): Promise<boolean> {
    const info = await $.session.info().catch(() => undefined);
    const dir = info?.scratchpadDir?.replace(/[\\/]+$/, "");

    return dir !== undefined && dir.length > 0 && path.startsWith(dir) && /^[\\/]/.test(path.slice(dir.length));
}
