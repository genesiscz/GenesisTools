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
    // `CardAccent` includes "amber" which IconContainer doesn't support — map it to orange.
    const accentToIcon = (a: CardAccent | undefined): IconContainerVariant => {
        if (!a) {
            return "purple";
        }

        if (a === "violet") {
            return "purple";
        }

        if (a === "amber") {
            return "orange";
        }

        return a;
    };

    const effectiveIconVariant: IconContainerVariant = iconVariant ?? accentToIcon(accent);

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

export type FeatureCardNexusColor = "cyan" | "purple" | "amber" | "emerald" | "rose" | "blue" | "primary";

interface FeatureCardNexusProps {
    color?: FeatureCardNexusColor;
    onClick?: () => void;
    className?: string;
    children?: React.ReactNode;
    style?: React.CSSProperties;
}

const featureCardNexusColors: Record<
    FeatureCardNexusColor,
    {
        border: string;
        corner: string;
        glow: string;
        shadow: string;
    }
> = {
    cyan: {
        border: "border-cyan-500/20 hover:border-cyan-500/40",
        corner: "border-cyan-500/30 group-hover:border-cyan-500/60",
        glow: "bg-cyan-500/10",
        shadow: "hover:shadow-lg hover:shadow-cyan-500/10",
    },
    purple: {
        border: "border-purple-500/20 hover:border-purple-500/40",
        corner: "border-purple-500/30 group-hover:border-purple-500/60",
        glow: "bg-purple-500/10",
        shadow: "hover:shadow-lg hover:shadow-purple-500/10",
    },
    amber: {
        border: "border-amber-500/20 hover:border-amber-500/40",
        corner: "border-amber-500/30 group-hover:border-amber-500/60",
        glow: "bg-amber-500/10",
        shadow: "hover:shadow-lg hover:shadow-amber-500/10",
    },
    emerald: {
        border: "border-emerald-500/20 hover:border-emerald-500/40",
        corner: "border-emerald-500/30 group-hover:border-emerald-500/60",
        glow: "bg-emerald-500/10",
        shadow: "hover:shadow-lg hover:shadow-emerald-500/10",
    },
    rose: {
        border: "border-rose-500/20 hover:border-rose-500/40",
        corner: "border-rose-500/30 group-hover:border-rose-500/60",
        glow: "bg-rose-500/10",
        shadow: "hover:shadow-lg hover:shadow-rose-500/10",
    },
    blue: {
        border: "border-blue-500/20 hover:border-blue-500/40",
        corner: "border-blue-500/30 group-hover:border-blue-500/60",
        glow: "bg-blue-500/10",
        shadow: "hover:shadow-lg hover:shadow-blue-500/10",
    },
    primary: {
        border: "border-primary/20 hover:border-primary/40",
        corner: "border-primary/30 group-hover:border-primary/60",
        glow: "bg-primary/10",
        shadow: "hover:shadow-lg hover:shadow-primary/10",
    },
};

export function FeatureCardNexus({ color = "primary", onClick, className, children, style }: FeatureCardNexusProps) {
    const colors = featureCardNexusColors[color];
    const Wrapper = onClick ? "button" : "div";

    return (
        <Wrapper
            onClick={onClick}
            style={style}
            className={cn(
                "group relative overflow-hidden rounded-xl",
                "bg-[#0a0a14]/80 backdrop-blur-sm",
                "border",
                colors.border,
                colors.shadow,
                "transition-all duration-300",
                onClick && "cursor-pointer",
                className
            )}
        >
            <div
                className={cn(
                    "absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 rounded-tl transition-colors",
                    colors.corner
                )}
            />
            <div
                className={cn(
                    "absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 rounded-tr transition-colors",
                    colors.corner
                )}
            />
            <div
                className={cn(
                    "absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 rounded-bl transition-colors",
                    colors.corner
                )}
            />
            <div
                className={cn(
                    "absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 rounded-br transition-colors",
                    colors.corner
                )}
            />

            <div
                className={cn(
                    "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full blur-3xl",
                    colors.glow
                )}
            />

            {children}
        </Wrapper>
    );
}

export function FeatureCardNexusHeader({ className, children }: { className?: string; children: React.ReactNode }) {
    return <div className={cn("flex flex-col space-y-1.5 p-6 relative", className)}>{children}</div>;
}

export function FeatureCardNexusTitle({ className, children }: { className?: string; children: React.ReactNode }) {
    return <h3 className={cn("text-2xl font-semibold leading-none tracking-tight", className)}>{children}</h3>;
}

export function FeatureCardNexusDescription({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

export function FeatureCardNexusContent({ className, children }: { className?: string; children: React.ReactNode }) {
    return <div className={cn("p-6 pt-0 relative", className)}>{children}</div>;
}

export { featureCardNexusColors };
