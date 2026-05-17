import { cn } from "@ui/lib/utils";
import { Flame } from "lucide-react";

interface StreakBadgeProps {
    days: number;
    className?: string;
}

export function StreakBadge({ days, className }: StreakBadgeProps) {
    return (
        <div className={cn("flex items-center gap-1.5 text-sm text-orange-400", className)}>
            <Flame className="h-4 w-4" />
            <span className="font-semibold">
                {days} day{days === 1 ? "" : "s"} streak
            </span>
        </div>
    );
}
