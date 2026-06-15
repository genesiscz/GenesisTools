import type { LineCounts } from "./classify";

export type GroupBy = "lang" | "ext";

export interface FileResult {
    ext: string;
    language: string;
    counts: LineCounts;
}

export interface Row {
    name: string;
    files: number;
    lines: number;
    code: number;
    comment: number;
    blank: number;
}

export type Totals = Omit<Row, "name">;

export interface Report {
    root: string;
    by: GroupBy;
    generatedAt: string;
    rows: Row[];
    total: Totals;
}

export interface BuildReportInput {
    root: string;
    by: GroupBy;
    files: FileResult[];
    now: Date;
    top?: number;
}

export function buildReport({ root, by, files, now, top }: BuildReportInput): Report {
    const groups = new Map<string, Row>();
    const total: Totals = { files: 0, lines: 0, code: 0, comment: 0, blank: 0 };

    for (const file of files) {
        const key = by === "ext" ? file.ext || "(no ext)" : file.language;
        const lines = file.counts.code + file.counts.comment + file.counts.blank;
        const row = groups.get(key) ?? { name: key, files: 0, lines: 0, code: 0, comment: 0, blank: 0 };

        row.files += 1;
        row.lines += lines;
        row.code += file.counts.code;
        row.comment += file.counts.comment;
        row.blank += file.counts.blank;
        groups.set(key, row);

        total.files += 1;
        total.lines += lines;
        total.code += file.counts.code;
        total.comment += file.counts.comment;
        total.blank += file.counts.blank;
    }

    const sorted = [...groups.values()].sort((a, b) => {
        if (b.code !== a.code) {
            return b.code - a.code;
        }

        if (b.lines !== a.lines) {
            return b.lines - a.lines;
        }

        return a.name.localeCompare(b.name);
    });

    const rows = typeof top === "number" ? sorted.slice(0, top) : sorted;

    return { root, by, generatedAt: now.toISOString(), rows, total };
}
