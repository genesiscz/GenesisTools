import { cn } from "@ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const alertVariants = cva(
    "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&:has(svg)]:pl-11",
    {
        variants: {
            variant: {
                default: "bg-background text-foreground",
                destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
                warning: "border-amber-500/30 bg-amber-500/5 text-amber-400 [&>svg]:text-amber-400",
            },
        },
        defaultVariants: { variant: "default" },
    }
);

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
    return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="alert-title"
            className={cn("mb-1 font-medium leading-none tracking-tight", className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="alert-description" className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
