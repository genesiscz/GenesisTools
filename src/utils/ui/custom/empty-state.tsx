import { cn } from "@ui/lib/utils";
import type React from "react";

type IconComponent = React.ElementType<{ className?: string }>;

interface EmptyStateIconProps {
    icon: IconComponent;
    size?: "md" | "lg";
    rings?: boolean;
}

export function EmptyStateIcon({ icon: Icon, size = "lg", rings = true }: EmptyStateIconProps) {
    const dimension = size === "lg" ? "w-32 h-32" : "w-24 h-24";
    const iconSize = size === "lg" ? "h-12 w-12" : "h-10 w-10";

    return (
        <div
            className={cn(
                "relative mb-8 flex items-center justify-center rounded-full",
                "bg-gradient-to-br from-purple-500/10 to-purple-500/5",
                "border border-purple-500/20",
                rings && "animate-pulse-glow",
                dimension
            )}
        >
            {rings && (
                <>
                    <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple" />
                    <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple-delayed" />
                </>
            )}
            <Icon className={cn("text-purple-400/50", iconSize)} />
        </div>
    );
}

interface EmptyStateProps {
    icon: IconComponent;
    title: string;
    description: string;
    cta?: React.ReactNode;
    children?: React.ReactNode;
    descriptionClassName?: string;
    iconSize?: "md" | "lg";
    rings?: boolean;
    className?: string;
}

export function EmptyState({
    icon,
    title,
    description,
    cta,
    children,
    descriptionClassName,
    iconSize,
    rings,
    className,
}: EmptyStateProps) {
    return (
        <div className={cn("flex flex-col items-center justify-center py-24 px-6", className)}>
            <EmptyStateIcon icon={icon} size={iconSize} rings={rings} />
            <h2 className="text-xl font-semibold text-foreground/70 mb-2">{title}</h2>
            <p className={cn("text-muted-foreground text-center max-w-md mb-8", descriptionClassName)}>{description}</p>
            {children}
            {cta}
        </div>
    );
}
