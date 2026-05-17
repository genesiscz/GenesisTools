import { cn } from "@ui/lib/utils";
import { useTheme } from "@ui/theme/provider";
import type * as React from "react";

type SkeletonVariant = "default" | "cyber" | "data-stream" | "card" | "line" | "nexus";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: SkeletonVariant;
}

const skeletonVariants: Record<SkeletonVariant, string> = {
    default: "bg-muted animate-pulse",
    cyber: [
        "glass-card",
        "bg-gradient-to-r from-transparent via-primary/10 to-transparent",
        "bg-[length:200%_100%]",
        "animate-skeleton-shimmer",
        "border border-primary/10",
    ].join(" "),
    "data-stream": ["bg-muted/50", "animate-data-stream", "origin-left"].join(" "),
    card: "wow-skeleton rounded-xl h-32 w-full",
    line: "wow-skeleton rounded-md h-4 w-full",
    nexus: "bg-accent animate-pulse",
};

function Skeleton({ className, variant, ...props }: SkeletonProps) {
    const { variant: themeVariant } = useTheme();
    const resolvedVariant = variant ?? (themeVariant === "nexus" ? "nexus" : "cyber");

    return <div className={cn("rounded-md", skeletonVariants[resolvedVariant], className)} {...props} />;
}

export { Skeleton, type SkeletonProps, type SkeletonVariant };
