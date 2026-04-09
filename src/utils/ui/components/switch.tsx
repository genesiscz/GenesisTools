import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@ui/lib/utils";
import type * as React from "react";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={cn(
                "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input shadow-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
                className
            )}
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
            />
        </SwitchPrimitive.Root>
    );
}

export { Switch };
