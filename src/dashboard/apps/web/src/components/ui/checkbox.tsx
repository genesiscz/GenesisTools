import { Check } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

type CheckedState = boolean | "indeterminate";

type CheckboxProps = Omit<React.ComponentProps<"button">, "checked" | "defaultChecked" | "onChange"> & {
    checked?: CheckedState;
    onCheckedChange?: (checked: CheckedState) => void;
};

function Checkbox({ className, checked = false, disabled, onCheckedChange, onClick, ...props }: CheckboxProps) {
    const isIndeterminate = checked === "indeterminate";
    const isChecked = checked === true;
    const state = isIndeterminate ? "indeterminate" : isChecked ? "checked" : "unchecked";

    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={isIndeterminate ? "mixed" : isChecked}
            data-slot="checkbox"
            data-state={state}
            disabled={disabled}
            className={cn(
                "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
                className
            )}
            onClick={(event) => {
                onClick?.(event);

                if (event.defaultPrevented || disabled) {
                    return;
                }

                onCheckedChange?.(!isChecked);
            }}
            {...props}
        >
            {(isChecked || isIndeterminate) && <Check className="size-3.5" />}
        </button>
    );
}

export { Checkbox };
