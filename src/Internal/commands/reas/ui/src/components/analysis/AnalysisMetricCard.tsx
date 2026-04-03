import type { LucideIcon } from "lucide-react";
import { StatCard } from "./StatCard";

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
        <StatCard
            label={label}
            value={value}
            hint={hint}
            icon={Icon}
            valueClassName={valueClassName}
            className={className}
        />
    );
}
