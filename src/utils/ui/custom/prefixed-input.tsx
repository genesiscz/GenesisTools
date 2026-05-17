import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { type ComponentProps, forwardRef, type ReactNode } from "react";

interface PrefixedInputProps extends ComponentProps<typeof Input> {
    icon: ReactNode;
    iconSpacing?: "tight" | "wide";
}

export const PrefixedInput = forwardRef<HTMLInputElement, PrefixedInputProps>(
    ({ icon, iconSpacing = "wide", className, ...rest }, ref) => {
        const padding = iconSpacing === "tight" ? "pl-9" : "pl-10";

        return (
            <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                    {icon}
                </span>
                <Input ref={ref} className={cn(padding, className)} {...rest} />
            </div>
        );
    }
);

PrefixedInput.displayName = "PrefixedInput";
