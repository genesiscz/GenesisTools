import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@ui/lib/utils";
import { useTheme } from "@ui/theme/provider";
import type * as React from "react";

type SwitchVariant = "default" | "nexus";

interface SwitchProps extends React.ComponentProps<typeof SwitchPrimitive.Root> {
    variant?: SwitchVariant;
}

const switchRootVariants: Record<SwitchVariant, string> = {
    default:
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input shadow-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
    nexus: "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-gray-600 focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
};

const switchThumbVariants: Record<SwitchVariant, string> = {
    default:
        "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
    nexus: "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
};

function Switch({ className, variant, ...props }: SwitchProps) {
    const { variant: themeVariant } = useTheme();
    const resolvedVariant = variant ?? (themeVariant === "nexus" ? "nexus" : "default");

    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={cn(switchRootVariants[resolvedVariant], className)}
            {...props}
        >
            <SwitchPrimitive.Thumb data-slot="switch-thumb" className={switchThumbVariants[resolvedVariant]} />
        </SwitchPrimitive.Root>
    );
}

export { Switch };
