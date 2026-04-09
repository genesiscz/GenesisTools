import type { PropertyAnalysisHistoryRow } from "@app/Internal/commands/reas/lib/store";

export function buildSparklinePoints(
    history: PropertyAnalysisHistoryRow[],
    getValue: (row: PropertyAnalysisHistoryRow) => number | null
): string[] {
    const values = [...history]
        .sort((left, right) => new Date(left.analyzed_at).getTime() - new Date(right.analyzed_at).getTime())
        .map((row) => getValue(row))
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    if (values.length < 2) {
        return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);

    return values.map((value, index) => {
        const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
        const y = max === min ? 12 : 24 - ((value - min) / (max - min)) * 24;
        return `${trimPoint(x)},${trimPoint(y)}`;
    });
}

export function PropertySparkline({
    history,
    getValue,
    stroke,
}: {
    history: PropertyAnalysisHistoryRow[];
    getValue: (row: PropertyAnalysisHistoryRow) => number | null;
    stroke: string;
}) {
    const points = buildSparklinePoints(history, getValue);

    if (points.length < 2) {
        return null;
    }

    return (
        <svg viewBox="0 0 100 24" className="h-6 w-20 overflow-visible" aria-hidden="true">
            <polyline
                fill="none"
                stroke={stroke}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={points.join(" ")}
            />
        </svg>
    );
}

function trimPoint(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }

    return value.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}
