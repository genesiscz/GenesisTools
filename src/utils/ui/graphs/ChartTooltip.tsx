import { chartLabelStyle, chartTooltipStyle } from "@ui/graphs/chart-theme";
import { cn } from "@ui/lib/utils";
import type { NameType, Payload, ValueType } from "recharts/types/component/DefaultTooltipContent";

interface ChartTooltipContentProps {
    active?: boolean;
    label?: string | number;
    payload?: Payload<ValueType, NameType>[];
    labelFormatter?: (value: string | number) => string;
    valueFormatter?: (value: ValueType | undefined, name: NameType | undefined) => string;
    className?: string;
}

function defaultValueFormatter(value: ValueType | undefined, name: NameType | undefined): string {
    return `${String(name)}: ${String(value)}`;
}

function ChartTooltipContent({
    active,
    label,
    payload,
    labelFormatter,
    valueFormatter = defaultValueFormatter,
    className,
}: ChartTooltipContentProps) {
    if (!active || !payload || payload.length === 0) {
        return null;
    }

    const title = label !== undefined ? (labelFormatter ? labelFormatter(label) : String(label)) : null;

    return (
        <div className={cn("min-w-48 rounded-xl px-3 py-2 text-xs", className)} style={chartTooltipStyle}>
            {title ? (
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-300">{title}</div>
            ) : null}
            <div className="flex flex-col gap-1.5">
                {payload.map((entry) => (
                    <div key={`${entry.name}-${entry.dataKey}`} className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: entry.color ?? "currentColor" }}
                            />
                            <span style={chartLabelStyle}>{String(entry.name ?? entry.dataKey ?? "value")}</span>
                        </div>
                        <span className="font-mono text-slate-100">{valueFormatter(entry.value, entry.name)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export { ChartTooltipContent };
