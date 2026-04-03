import { Card, CardContent } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { STAT_CARD_ACCENT_STYLES, type StatCardAccent } from "./shared";

interface StatCardProps {
    label: string;
    value: string;
    hint?: string;
    icon?: LucideIcon;
    valueClassName?: string;
    className?: string;
    accent?: StatCardAccent;
}

export function StatCard({
    label,
    value,
    hint,
    icon: Icon,
    valueClassName,
    className,
    accent = "amber",
}: StatCardProps) {
    return (
        <Card className={cn("border-white/5 border-l-2 bg-white/[0.02]", STAT_CARD_ACCENT_STYLES[accent], className)}>
            <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-mono uppercase tracking-[0.24em] text-slate-500">{label}</span>
                    {Icon ? <Icon className="h-4 w-4 text-slate-400" /> : null}
                </div>
                <div className={cn("text-2xl font-mono font-semibold text-white", valueClassName)}>{value}</div>
                {hint ? <p className="text-xs font-mono leading-5 text-slate-400">{hint}</p> : null}
            </CardContent>
        </Card>
    );
}
