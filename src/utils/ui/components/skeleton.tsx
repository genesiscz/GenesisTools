import { cn } from "@ui/lib/utils";
import type * as React from "react";

type SkeletonVariant = "default" | "cyber" | "data-stream" | "card" | "line";

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
};

function Skeleton({ className, variant = "cyber", ...props }: SkeletonProps) {
    return <div className={cn("rounded-md", skeletonVariants[variant], className)} {...props} />;
}

export { Skeleton, type SkeletonProps, type SkeletonVariant };
