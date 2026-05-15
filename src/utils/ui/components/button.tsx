import { Slot } from "@radix-ui/react-slot";
import { cn } from "@ui/lib/utils";
import { useTheme } from "@ui/theme/provider";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                destructive:
                    "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
                outline:
                    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
                secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
                link: "text-primary underline-offset-4 hover:underline",
                brand: "bg-purple-600 text-white hover:bg-purple-700 shadow-lg shadow-purple-500/20 hover:shadow-xl hover:shadow-purple-500/30 transition-all",
                nexus: "bg-primary text-primary-foreground hover:bg-primary/90",
                cyber: "glass-card neon-border border-primary/30 bg-transparent text-primary hover:bg-primary/10 hover:border-primary/50 btn-glow",
                "cyber-secondary":
                    "glass-card border-secondary/30 bg-transparent text-secondary hover:bg-secondary/10 hover:border-secondary/50",
                "cyber-ghost": "bg-transparent text-primary hover:bg-primary/10 hover:text-primary",
            },
            size: {
                default: "h-9 px-4 py-2 has-[>svg]:px-3",
                sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
                lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
                icon: "size-9",
                "icon-sm": "size-8",
                "icon-lg": "size-10",
            },
        },
        defaultVariants: {
            variant: "cyber",
            size: "default",
        },
    }
);

function Button({
    className,
    variant,
    size = "default",
    asChild = false,
    type,
    ...props
}: React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
    }) {
    const Comp = asChild ? Slot : "button";
    const { variant: themeVariant } = useTheme();
    const resolvedVariant = variant ?? (themeVariant === "nexus" ? "nexus" : "default");

    return (
        <Comp
            data-slot="button"
            data-variant={resolvedVariant}
            data-size={size}
            className={cn(buttonVariants({ variant: resolvedVariant, size, className }))}
            type={!asChild ? (type ?? "button") : undefined}
            {...props}
        />
    );
}

export { Button, buttonVariants };
