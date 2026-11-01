import { toolCommand } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import type { TrashBatch } from "@genesiscz/utils/rm";
import { stripAnsi } from "@genesiscz/utils/string";
import { formatDotStatus } from "@genesiscz/utils/table";
import pc from "picocolors";
import { displayContext, middleCut, shortRmPath } from "./display";

export interface TrashViewOptions {
    now: Date;
    /** Each batch's size as `--sizes` walked it; without it a size is the sum of the bytes measured after the move. */
    measured?: ReadonlyMap<string, number>;
}

const SUFFIX_MIN = 4;
const PATH_MAX = 40;

/** The shortest tail of `id`, at least 4 characters, that no other batch id ends with. */
export function batchSuffix(id: string, ids: readonly string[]): string {
    for (let length = SUFFIX_MIN; length < id.length; length++) {
        const tail = id.slice(-length);

        if (ids.filter((other) => other.endsWith(tail)).length === 1) {
            return tail;
        }
    }

    return id;
}

/** The batch a typed id names: the whole id, or a tail that only one batch ends with. */
export function resolveBatchSuffix(
    typed: string,
    ids: readonly string[]
): { id: string } | { ambiguous: string[] } | null {
    if (ids.includes(typed)) {
        return { id: typed };
    }

    if (typed.length < SUFFIX_MIN) {
        return null;
    }

    const matches = ids.filter((id) => id.endsWith(typed));

    if (matches.length === 1) {
        return { id: matches[0] };
    }

    return matches.length > 1 ? { ambiguous: matches } : null;
}

/** `text` padded to `width` visible characters: a dot status cell carries color codes. */
function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - stripAnsi(text).length));
}

function clock(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function left(iso: string, now: Date): string {
    const minutes = Math.ceil((Date.parse(iso) - now.getTime()) / 60_000);
    return minutes <= 0 ? "due now" : `in ${minutes} min`;
}

/** A batch's size: the measured walk, else the bytes recorded after each move (`+` when some item has none). */
function sizeOf(batch: TrashBatch, measured: ReadonlyMap<string, number> | undefined): string {
    const walked = measured?.get(batch.id);

    if (walked !== undefined) {
        return formatBytes(walked);
    }

    const known = batch.items.filter((item) => item.bytes !== undefined);

    if (known.length === 0) {
        return "-";
    }

    const bytes = known.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    return `${formatBytes(bytes)}${known.length < batch.items.length ? "+" : ""}`;
}

function asker(batch: TrashBatch): string {
    const caller = batch.caller;

    if (!caller?.sessionId) {
        return caller?.isInAgent === false ? "person" : "-";
    }

    const title = caller.sessionTitle ? ` ${middleCut(caller.sessionTitle, 28)}` : "";
    return `${caller.sessionId.slice(0, 8)}${title}`;
}

/**
 * `tools rm trash`: a header with the totals and the next drain, one row per batch (its id tail, drain time, size,
 * asker, item count and first path), and the two commands that act on it.
 */
export function renderTrash(batches: readonly TrashBatch[], options: TrashViewOptions): string[] {
    if (batches.length === 0) {
        return ["The trash is empty."];
    }

    const ids = batches.map((batch) => batch.id);
    const sorted = [...batches].sort((a, b) => Date.parse(a.drainAfter) - Date.parse(b.drainAfter));
    const items = batches.reduce((sum, batch) => sum + batch.items.length, 0);
    const next = sorted.find((batch) => !batch.incomplete);
    const known = batches.flatMap((batch) =>
        options.measured?.has(batch.id) ? [options.measured.get(batch.id) ?? 0] : batch.items.map((i) => i.bytes ?? 0)
    );
    const total = known.reduce((sum, bytes) => sum + bytes, 0);
    const header = [
        `${batches.length} batch${batches.length === 1 ? "" : "es"}`,
        `${items} item${items === 1 ? "" : "s"}`,
        formatBytes(total),
        ...(next ? [`next drain ${clock(next.drainAfter)} (${left(next.drainAfter, options.now)})`] : []),
    ];
    const rows = sorted.map((batch) => {
        const first = batch.items[0];
        const path = first ? shortRmPath(first.original, displayContext(batch.caller), PATH_MAX) : "-";
        const more = batch.items.length > 1 ? ` +${batch.items.length - 1}` : "";
        return {
            id: batchSuffix(batch.id, ids),
            drain: batch.incomplete
                ? formatDotStatus("warn", "moving, or the next sweep finishes it")
                : `${clock(batch.drainAfter)} (${left(batch.drainAfter, options.now)})`,
            size: sizeOf(batch, options.measured),
            asker: asker(batch),
            count: `${batch.items.length} item${batch.items.length === 1 ? "" : "s"}`,
            path: `${path}${more}`,
        };
    });
    const width = (pick: (row: (typeof rows)[number]) => string) =>
        Math.max(...rows.map((row) => stripAnsi(pick(row)).length));
    const widths = {
        id: width((row) => row.id),
        drain: width((row) => row.drain),
        size: width((row) => row.size),
        asker: width((row) => row.asker),
        count: width((row) => row.count),
    };
    const rm = toolCommand("rm");

    return [
        `${pc.bold("rm trash")}  ${header.join(" · ")}`,
        ...rows.map(
            (row) =>
                `  ${pc.bold(row.id.padEnd(widths.id))}  ${pad(row.drain, widths.drain)}  ${row.size.padStart(widths.size)}  ` +
                `${row.asker.padEnd(widths.asker)}  ${row.count.padStart(widths.count)}  ${pc.dim(row.path)}`
        ),
        "",
        pc.dim(`Undo: ${rm} restore <batch>   Drain now (a person): ${rm} drain --now`),
    ];
}
