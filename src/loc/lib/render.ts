import { formatNumber } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Report } from "./aggregate";

export function renderTable(report: Report): string {
    const nameHeader = report.by === "ext" ? "Ext" : "Language";
    const headers = [nameHeader, "Files", "Lines", "Code", "Comment", "Blank"];

    const rows = report.rows.map((r) => [
        r.name,
        formatNumber(r.files),
        formatNumber(r.lines),
        formatNumber(r.code),
        formatNumber(r.comment),
        formatNumber(r.blank),
    ]);

    const total = report.total;
    rows.push([
        "Total",
        formatNumber(total.files),
        formatNumber(total.lines),
        formatNumber(total.code),
        formatNumber(total.comment),
        formatNumber(total.blank),
    ]);

    return formatTable(rows, headers, { alignRight: [1, 2, 3, 4, 5] });
}
