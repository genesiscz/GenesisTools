import { Card, type CardAccent } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type React from "react";
import { IconContainer, type IconContainerVariant } from "./icon-container";

interface FeatureCardProps {
    title: string;
    subtitle?: string;
    description?: string;
    icon?: React.ReactNode;
    /** Override the icon container color. Defaults to `accent` when set. */
    iconVariant?: IconContainerVariant;
    /** Tints the card border, hover glow, and (by default) icon with this color. */
    accent?: CardAccent;
    badge?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
}

export function FeatureCard({
    title,
    subtitle,
    description,
    icon,
    iconVariant,
    accent,
    badge,
    children,
    className,
}: FeatureCardProps) {
    // Auto-derive icon color from accent if not explicitly overridden.
    const effectiveIconVariant: IconContainerVariant =
        iconVariant ?? ((accent === "violet" ? "purple" : accent) as IconContainerVariant) ?? "purple";

    return (
        <Card accent={accent} className={cn("rounded-[20px] p-6 gap-4", className)}>
            {(icon || badge) && (
                <div className="flex items-start justify-between">
                    {icon && <IconContainer icon={icon} variant={effectiveIconVariant} />}
                    {badge}
                </div>
            )}
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {subtitle && <p className="text-sm text-muted-foreground -mt-3">{subtitle}</p>}
            {description && <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>}
            {children && <div>{children}</div>}
        </Card>
    );
}
