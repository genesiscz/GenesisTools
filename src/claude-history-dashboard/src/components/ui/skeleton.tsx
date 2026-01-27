import { cn } from "@/lib/utils"

type SkeletonVariant = "default" | "cyber" | "data-stream"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant
}

const skeletonVariants: Record<SkeletonVariant, string> = {
  default: "bg-muted animate-pulse",
  cyber: [
    "glass-card",
    "bg-gradient-to-r from-transparent via-amber-500/10 to-transparent",
    "bg-[length:200%_100%]",
    "animate-skeleton-shimmer",
    "border border-amber-500/10",
  ].join(" "),
  "data-stream": [
    "bg-muted/50",
    "animate-data-stream",
    "origin-left",
  ].join(" "),
}

function Skeleton({ className, variant = "cyber", ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "rounded-md",
        skeletonVariants[variant],
        className
      )}
      {...props}
    />
  )
}

export { Skeleton, type SkeletonProps, type SkeletonVariant }
