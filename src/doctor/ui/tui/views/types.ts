import type { Finding } from "@app/doctor/lib/types";

export type CellChunk = { text: string; fg?: string; bg?: string };
export type Cell = CellChunk[];
export type Row = Cell[];

export interface ColumnSpec {
    header: string;
    /** flex weight for columnFitter="balanced" when columnWidthMode="fill". 0 = content-sized. */
    weight?: number;
    /** "right" renders the cell pre-padded so the chunk aligns right. Text-only formatter. */
    align?: "left" | "right";
}

export interface ViewContext {
    findings: Finding[];
    selected: Set<string>;
    cursor: number;
    /** available rows in the drawer body (excluding header). The view should slice accordingly. */
    viewportRows: number;
}

export interface ViewResult {
    columns: ColumnSpec[];
    rows: Row[];
    /** For the footer: "N of M findings". */
    total: number;
}

export type ViewFn = (ctx: ViewContext) => ViewResult;
