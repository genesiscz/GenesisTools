import { cn } from "@ui/lib/utils";
import { Loader2 } from "lucide-react";

interface PageLoadingSpinnerProps {
    label?: string;
    className?: string;
}

export function PageLoadingSpinner({ label = "Loading...", className }: PageLoadingSpinnerProps) {
    return (
        <div className={cn("flex items-center justify-center min-h-[60vh]", className)}>
            <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
                <span className="text-muted-foreground text-sm font-mono">{label}</span>
            </div>
        </div>
    );
}
