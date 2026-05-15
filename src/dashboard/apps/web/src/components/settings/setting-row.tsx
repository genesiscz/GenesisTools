import { Label } from "@ui/components/label";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface SettingRowProps {
    label: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}

/**
 * SettingRow — a label+description+control row for settings pages.
 * Control (switch/select/button) is passed as children on the right.
 */
export function SettingRow({ label, description, children, className }: SettingRowProps) {
    return (
        <div className={cn("flex items-center justify-between gap-4 py-2", className)}>
            <div className="space-y-0.5 min-w-0">
                <Label className="text-sm text-foreground cursor-default">{label}</Label>
                {description && (
                    <p className="text-xs text-muted-foreground font-mono leading-snug">{description}</p>
                )}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}
