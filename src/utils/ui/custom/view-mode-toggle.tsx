import { IconButton } from "@ui/components/icon-button";
import { cn } from "@ui/lib/utils";
import type React from "react";

// Not React.ElementType: its union of every HTML tag made each JSX use ~175k instantiations (see app-sidebar.tsx).
type IconComponent = React.ComponentType<{ className?: string }>;

export interface ViewMode<V extends string> {
    value: V;
    label: string;
    icon: IconComponent;
}

interface ViewModeToggleProps<V extends string> {
    modes: ViewMode<V>[];
    value: V;
    onChange: (value: V) => void;
    className?: string;
}

export function ViewModeToggle<V extends string>({ modes, value, onChange, className }: ViewModeToggleProps<V>) {
    return (
        <div className={cn("flex items-center border rounded-lg overflow-hidden", className)}>
            {modes.map((mode) => {
                const Icon = mode.icon;
                const isActive = value === mode.value;

                return (
                    <IconButton
                        key={mode.value}
                        variant="ghost"
                        size="sm"
                        tooltip={`${mode.label} view`}
                        onClick={() => onChange(mode.value)}
                        className={cn("h-8 px-3 rounded-none", isActive && "bg-purple-500/20 text-purple-400")}
                    >
                        <Icon className="h-4 w-4" />
                    </IconButton>
                );
            })}
        </div>
    );
}
