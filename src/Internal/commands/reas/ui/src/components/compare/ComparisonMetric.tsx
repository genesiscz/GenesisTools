import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";

interface MetricValue {
    district: string;
    value: number | string | null;
    formatted: string;
}

interface ComparisonMetricProps {
    label: string;
    values: MetricValue[];
    bestIndex: number | null;
    worstIndex: number | null;
    icon?: React.ReactNode;
}

export function ComparisonMetric({ label, values, bestIndex, worstIndex, icon }: ComparisonMetricProps) {
    return (
        <div className="grid gap-2" style={{ gridTemplateColumns: `140px repeat(${values.length}, 1fr)` }}>
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400 py-2 border-b border-white/5">
                {icon}
                {label}
            </div>
            {values.map((v, i) => (
                <div
                    key={v.district}
                    className={cn(
                        "flex items-center justify-center gap-2 py-2 border-b border-white/5 text-sm font-mono",
                        i === bestIndex && "text-emerald-400",
                        i === worstIndex && "text-red-400",
                        i !== bestIndex && i !== worstIndex && "text-gray-300"
                    )}
                >
                    <span>{v.formatted}</span>
                    {i === bestIndex && (
                        <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-500/30 text-emerald-400 px-1.5 py-0"
                        >
                            best
                        </Badge>
                    )}
                    {i === worstIndex && values.length > 2 && (
                        <Badge variant="outline" className="text-[10px] border-red-500/30 text-red-400 px-1.5 py-0">
                            worst
                        </Badge>
                    )}
                </div>
            ))}
        </div>
    );
}
