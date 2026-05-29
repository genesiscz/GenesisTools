import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export type SegmentedControlOption<T extends string> = {
    value: T;
    label: ReactNode;
    disabled?: boolean;
    "aria-label"?: string;
};

type SegmentedControlProps<T extends string> = {
    value: T;
    onValueChange: (value: T) => void;
    options: SegmentedControlOption<T>[];
    className?: string;
    size?: "sm" | "default";
    layout?: "label" | "icon";
    /** `dd` = dev-dashboard pulse green (active) + Add-button hover */
    tone?: "default" | "dd";
    "aria-label"?: string;
};

const themeItemClass =
    "min-w-0 flex-1 rounded-md border-0 bg-transparent font-medium shadow-none transition-colors " +
    "text-muted-foreground " +
    "hover:bg-accent hover:text-accent-foreground " +
    "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground " +
    "data-[state=on]:hover:bg-primary data-[state=on]:hover:text-primary-foreground " +
    "focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50";

const ddItemClass =
    "dd-segment-item min-w-0 flex-1 rounded-md border-0 bg-transparent font-semibold shadow-none " +
    "transition-[opacity,box-shadow,color] text-[var(--dd-text-secondary)] " +
    "hover:bg-transparent data-[state=on]:bg-transparent " +
    "focus-visible:ring-[color-mix(in_srgb,var(--dd-accent-from)_50%,transparent)] " +
    "disabled:pointer-events-none disabled:opacity-50";

function SegmentedControl<T extends string>({
    value,
    onValueChange,
    options,
    className,
    size = "sm",
    layout = "label",
    tone = "default",
    "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
    const itemClass = tone === "dd" ? ddItemClass : themeItemClass;

    return (
        <ToggleGroup
            type="single"
            size={size}
            value={value}
            aria-label={ariaLabel}
            onValueChange={(next) => {
                if (next) {
                    onValueChange(next as T);
                }
            }}
            className={cn(
                "inline-flex max-w-full gap-0.5 rounded-lg border border-input bg-muted/25 p-0.5",
                tone === "dd" && "dd-segmented-control border-[var(--dd-border)] bg-black/20",
                layout === "icon" ? "w-auto" : "w-full",
                className
            )}
        >
            {options.map((option) => (
                <ToggleGroupItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    aria-label={option["aria-label"]}
                    className={cn(
                        itemClass,
                        size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
                        layout === "label" ? "px-4" : "flex flex-none items-center justify-center px-2.5"
                    )}
                >
                    {option.label}
                </ToggleGroupItem>
            ))}
        </ToggleGroup>
    );
}

export { SegmentedControl };
