import { cn } from "@ui/lib/utils";
import type React from "react";
import { IconBox } from "./icon-box";

interface IconSectionHeaderProps {
    icon: React.ReactNode;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    iconBgClass: string;
    iconBorderClass: string;
    iconColorClass: string;
    actions?: React.ReactNode;
    className?: string;
}

export function IconSectionHeader({
    icon,
    title,
    subtitle,
    iconBgClass,
    iconBorderClass,
    iconColorClass,
    actions,
    className,
}: IconSectionHeaderProps) {
    return (
        <div className={cn("flex items-center justify-between gap-4", className)}>
            <div className="flex items-center gap-3">
                <IconBox
                    icon={icon}
                    size="lg"
                    bgClass={iconBgClass}
                    borderClass={iconBorderClass}
                    iconClass={iconColorClass}
                />
                <div>
                    <h3 className="text-lg font-semibold">{title}</h3>
                    {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
                </div>
            </div>
            {actions}
        </div>
    );
}
