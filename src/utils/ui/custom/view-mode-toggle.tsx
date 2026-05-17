import { Button } from "@ui/components/button";
import { cn } from "@ui/lib/utils";
import type React from "react";

type IconComponent = React.ElementType<{ className?: string }>;

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
                    <Button
                        key={mode.value}
                        variant="ghost"
                        size="sm"
                        onClick={() => onChange(mode.value)}
                        className={cn("h-8 px-3 rounded-none", isActive && "bg-purple-500/20 text-purple-400")}
                        title={`${mode.label} view`}
                    >
                        <Icon className="h-4 w-4" />
                    </Button>
                );
            })}
        </div>
    );
}
