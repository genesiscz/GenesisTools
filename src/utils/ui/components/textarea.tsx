import { cn } from "@ui/lib/utils";
import { useTheme } from "@ui/theme/provider";
import type * as React from "react";

type TextareaVariant = "default" | "nexus";

interface TextareaProps extends React.ComponentProps<"textarea"> {
    variant?: TextareaVariant;
}

const textareaVariants: Record<TextareaVariant, string> = {
    default:
        "flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    nexus: "border-white/20 placeholder:text-muted-foreground focus-visible:border-purple-500/50 focus-visible:ring-purple-500/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
};

function Textarea({ className, variant, ...props }: TextareaProps) {
    const { variant: themeVariant } = useTheme();
    const resolvedVariant = variant ?? (themeVariant === "nexus" ? "nexus" : "default");

    return <textarea data-slot="textarea" className={cn(textareaVariants[resolvedVariant], className)} {...props} />;
}

export { Textarea };
