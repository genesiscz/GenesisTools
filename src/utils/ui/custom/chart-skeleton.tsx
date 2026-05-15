import { cn } from "@ui/lib/utils";

const HEIGHT_PATTERN = [45, 68, 52, 84, 61, 74, 58, 90, 66, 49, 78, 55];

interface ChartSkeletonProps {
    bars?: number;
    className?: string;
}

export function ChartSkeleton({ bars = 7, className }: ChartSkeletonProps) {
    return (
        <div className={cn("h-[200px] flex items-end justify-around gap-2 p-4", className)}>
            {Array.from({ length: bars }).map((_, index) => (
                <div
                    key={index}
                    className="flex-1 rounded-t bg-muted animate-pulse"
                    style={{ height: `${HEIGHT_PATTERN[index % HEIGHT_PATTERN.length]}%` }}
                />
            ))}
        </div>
    );
}
