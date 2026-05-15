import { cn } from "@ui/lib/utils";
import { ParkingCircle } from "lucide-react";

interface ContextParkingBadgeProps {
    content: string;
    label?: string;
    size?: "compact" | "default" | "preview";
    className?: string;
}

export function ContextParkingBadge({
    content,
    label = "Parked",
    size = "default",
    className,
}: ContextParkingBadgeProps) {
    if (size === "preview") {
        return (
            <div className={cn("mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20", className)}>
                <div className="flex items-center gap-2 mb-1.5">
                    <ParkingCircle className="h-3.5 w-3.5 text-purple-400" />
                    <span className="text-xs font-medium text-purple-300">{label}:</span>
                </div>
                <p className="text-sm text-foreground/80 line-clamp-2">{content}</p>
            </div>
        );
    }

    const sizing = size === "compact" ? "mt-2 p-1.5 rounded text-[9px]" : "mt-3 p-2 rounded-lg text-[11px]";

    return (
        <div className={cn("bg-purple-500/10 border border-purple-500/20", sizing, className)}>
            <div className="flex items-start gap-1.5">
                <ParkingCircle className="h-3 w-3 text-purple-400 flex-shrink-0 mt-0.5" />
                <span className="text-purple-300/80 line-clamp-2">
                    <span className="font-semibold">{label}:</span> {content}
                </span>
            </div>
        </div>
    );
}
