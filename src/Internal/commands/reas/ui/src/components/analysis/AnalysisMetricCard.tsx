import { Card, CardContent } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";

interface AnalysisMetricCardProps {
    label: string;
    value: string;
    hint?: string;
    icon?: LucideIcon;
    valueClassName?: string;
    className?: string;
}

export function AnalysisMetricCard({
    label,
    value,
    hint,
    icon: Icon,
    valueClassName,
    className,
}: AnalysisMetricCardProps) {
    return (
        <Card className={cn("border-white/5 bg-white/[0.02]", className)}>
            <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-mono uppercase tracking-[0.24em] text-slate-500">{label}</span>
                    {Icon ? <Icon className="h-4 w-4 text-amber-300" /> : null}
                </div>
                <div className={cn("text-2xl font-semibold font-mono text-white", valueClassName)}>{value}</div>
                {hint ? <p className="text-xs font-mono leading-5 text-slate-400">{hint}</p> : null}
            </CardContent>
        </Card>
    );
}
