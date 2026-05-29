import { cn } from "@ui/lib/utils";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

type BezelCardProps<T extends ElementType = "div"> = {
    as?: T;
    children: ReactNode;
    className?: string;
    innerClassName?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "children" | "className">;

export function BezelCard<T extends ElementType = "div">({
    as,
    children,
    className,
    innerClassName,
    ...props
}: BezelCardProps<T>) {
    const Component = as ?? "div";

    return (
        <Component className={cn("rounded-[1.25rem] bg-white/5 p-1.5 ring-1 ring-white/10", className)} {...props}>
            <div
                className={cn(
                    "rounded-[calc(1.25rem-0.375rem)] bg-zinc-950/80 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]",
                    innerClassName
                )}
            >
                {children}
            </div>
        </Component>
    );
}
