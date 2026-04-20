import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import { meta } from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Title", weight: 4 },
    { header: "Detail", weight: 3 },
];

function toStatusRow(finding: Finding): StatusRow {
    const m = meta(finding);
    const checkLabel = typeof m.check === "string" && m.check.length > 0 ? m.check : finding.title;
    const passing = m.passing === true;
    const value = passing ? "✓ enabled" : "✗ disabled";
    const valueFg = passing ? THEME.success : THEME.sevDangerous;

    return { label: checkLabel, value, valueFg };
}

export const securityView: ViewFn = ({ findings }) => {
    const status = findings.map((finding) => toStatusRow(finding));

    const actionable: ActionableTable = {
        columns: COLUMNS,
        rows: [],
        findings: [],
        allFindings: [],
    };

    return { status, actionable, total: findings.length };
};
