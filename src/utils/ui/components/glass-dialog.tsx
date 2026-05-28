import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";

type GlassDialogSize = "md" | "lg";

const sizeClasses: Record<GlassDialogSize, string> = {
    md: "w-[min(96vw,640px)] sm:max-w-none",
    lg: "w-[min(96vw,960px)] sm:max-w-none",
};

interface GlassDialogContentProps extends ComponentProps<typeof DialogContent> {
    size?: GlassDialogSize;
    fixedHeight?: boolean;
    glow?: boolean;
}

export function GlassDialogContent({
    size = "md",
    fixedHeight = false,
    glow = true,
    className,
    children,
    ...props
}: GlassDialogContentProps) {
    return (
        <DialogContent
            className={cn(
                "flex flex-col gap-0 overflow-hidden border-white/10 bg-zinc-950/95 p-0 text-zinc-100 shadow-[0_0_80px_rgba(0,0,0,0.65)] backdrop-blur-xl",
                sizeClasses[size],
                fixedHeight ? "h-[min(88dvh,820px)] max-h-[95dvh]" : "max-h-[95dvh]",
                className
            )}
            {...props}
        >
            {glow ? (
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.08),transparent_55%)]" />
            ) : null}
            {children}
        </DialogContent>
    );
}

export function GlassDialogBody({ className, children, ...props }: ComponentProps<"div">) {
    return (
        <div className={cn("relative flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-6", className)} {...props}>
            {children}
        </div>
    );
}

export function GlassDialogScroll({ className, children, ...props }: ComponentProps<"div">) {
    return (
        <div className={cn("min-h-0 flex-1 overflow-y-auto pr-1", className)} {...props}>
            {children}
        </div>
    );
}

export function GlassDialogEyebrow({ className, children, ...props }: ComponentProps<"p">) {
    return (
        <p
            className={cn("font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500", className)}
            {...props}
        >
            {children}
        </p>
    );
}

export {
    Dialog as GlassDialog,
    DialogDescription as GlassDialogDescription,
    DialogFooter as GlassDialogFooter,
    DialogHeader as GlassDialogHeader,
    DialogTitle as GlassDialogTitle,
};

export type GlassDialogShellProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
};

export function GlassDialogShell({ open, onOpenChange, children }: GlassDialogShellProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {children}
        </Dialog>
    );
}
