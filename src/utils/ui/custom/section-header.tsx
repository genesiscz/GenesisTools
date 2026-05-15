import { cn } from "@ui/lib/utils";
import type React from "react";

interface SectionHeaderProps {
    title: string;
    subtitle?: string;
    badge?: React.ReactNode;
    className?: string;
}

export function SectionHeader({ title, subtitle, badge, className }: SectionHeaderProps) {
    return (
        <div className={cn("flex items-center justify-between mb-6", className)}>
            <div>
                <h3 className="text-2xl font-bold">{title}</h3>
                {subtitle && <p className="text-foreground/50 text-sm mt-1">{subtitle}</p>}
            </div>
            {badge && (
                <span className="text-xs font-semibold text-primary px-3 py-2 rounded-full bg-primary/10 border border-primary/30">
                    {badge}
                </span>
            )}
        </div>
    );
}
