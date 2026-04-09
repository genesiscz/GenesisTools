export type StatCardAccent = "amber" | "cyan" | "green" | "purple" | "rose" | "slate";
export type InfoBoxTone = "info" | "positive" | "warning" | "critical";
export type DataTablePrimitive = string | number | boolean | null | undefined;

export const STAT_CARD_ACCENT_STYLES: Record<StatCardAccent, string> = {
    amber: "border-l-amber-400",
    cyan: "border-l-cyan-400",
    green: "border-l-emerald-400",
    purple: "border-l-violet-400",
    rose: "border-l-rose-400",
    slate: "border-l-slate-500",
};

export const INFO_BOX_TONE_STYLES: Record<InfoBoxTone, string> = {
    info: "border-cyan-500/30 bg-cyan-500/10 text-cyan-100",
    positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-100",
    critical: "border-rose-500/30 bg-rose-500/10 text-rose-100",
};

export function getScoreGaugeDisplay({ score, max = 100 }: { score: number; max?: number }) {
    const safeMax = max > 0 ? max : 100;
    const clampedScore = Math.max(0, Math.min(score, safeMax));

    return {
        safeMax,
        clampedScore,
        angle: (clampedScore / safeMax) * 360,
    };
}

export function sortDataTableRows<Row extends object>({
    rows,
    direction,
    getValue,
}: {
    rows: Row[];
    direction: "asc" | "desc";
    getValue: (row: Row) => DataTablePrimitive;
}) {
    return [...rows].sort((left, right) => {
        const leftValue = getValue(left);
        const rightValue = getValue(right);

        if (leftValue === rightValue) {
            return 0;
        }

        if (leftValue == null) {
            return 1;
        }

        if (rightValue == null) {
            return -1;
        }

        const comparison = leftValue > rightValue ? 1 : -1;
        return direction === "asc" ? comparison : -comparison;
    });
}

export function summarizeProviderMessage(message: string): string {
    const compactMessage = message.replace(/\s+/g, " ").trim();

    if (compactMessage.length <= 160) {
        return compactMessage;
    }

    const statusSummaryMatch = compactMessage.match(/(\d{3}\s+[A-Za-z ]+\s+—\s+[^.]+)$/);

    if (statusSummaryMatch) {
        return statusSummaryMatch[1].trim();
    }

    const lastDividerIndex = compactMessage.lastIndexOf(" — ");

    if (lastDividerIndex >= 0) {
        return compactMessage.slice(lastDividerIndex + 3).trim();
    }

    return `${compactMessage.slice(0, 157)}…`;
}
