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

function conditionColor(condition: string): string | undefined {
    if (/service/i.test(condition)) {
        return THEME.sevDangerous;
    }

    if (/check|replace|poor/i.test(condition)) {
        return THEME.sevCautious;
    }

    return undefined;
}

function summaryStatus(finding: Finding, out: StatusRow[]): void {
    const m = meta(finding);

    if (typeof m.cycleCount === "number") {
        out.push({ label: "Cycle count", value: String(m.cycleCount) });
    }

    if (typeof m.condition === "string" && m.condition.length > 0) {
        out.push({
            label: "Condition",
            value: m.condition,
            valueFg: conditionColor(m.condition),
        });
    }

    if (typeof m.maxCapacityPct === "number") {
        out.push({ label: "Max capacity", value: `${m.maxCapacityPct}%` });
    }

    if (typeof m.stateOfChargePct === "number") {
        const fully = m.fullyCharged === true;
        out.push({
            label: "Charge",
            value: `${m.stateOfChargePct}%${fully ? " (full)" : ""}`,
        });
    }
}

function thermalStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const count = typeof m.eventCount === "number" ? m.eventCount : 0;

    return {
        label: "Thermal events",
        value: String(count),
        valueFg: count === 0 ? THEME.fgDim : THEME.sevCautious,
    };
}

export const batteryView: ViewFn = ({ findings }) => {
    const status: StatusRow[] = [];

    for (const finding of findings) {
        if (finding.id === "battery-summary") {
            summaryStatus(finding, status);
            continue;
        }

        if (finding.id === "battery-thermal") {
            status.push(thermalStatus(finding));
            continue;
        }

        status.push({ label: finding.title, value: finding.detail ?? "" });
    }

    const actionable: ActionableTable = {
        columns: COLUMNS,
        rows: [],
        findings: [],
        allFindings: [],
    };

    return { status, actionable, total: findings.length };
};
