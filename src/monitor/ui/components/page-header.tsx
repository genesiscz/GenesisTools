import { cn } from "@genesiscz/utils/ui/lib/utils";
import type { ReactNode } from "react";

export function PageHeader({
    eyebrow,
    live,
    title,
    description,
    actions,
    children,
    className,
}: {
    eyebrow: string;
    live?: boolean;
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    return (
        <header className={cn("mon-panel relative overflow-hidden rounded-3xl p-6", className)}>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-emerald-500/[0.07] via-transparent to-transparent" />
            <div className="relative flex flex-col gap-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-2">
                        <div className="flex items-center gap-3">
                            {live !== undefined && (
                                <span
                                    className={
                                        live
                                            ? "size-2 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.85)]"
                                            : "size-2 rounded-full bg-amber-400/70"
                                    }
                                />
                            )}
                            <p className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">
                                {eyebrow}
                                {live !== undefined && (live ? " · live" : " · reconnecting")}
                            </p>
                        </div>
                        <h1 className="bg-gradient-to-r from-emerald-200 via-amber-200 to-cyan-300 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
                            {title}
                        </h1>
                        {description && (
                            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
                        )}
                    </div>
                    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
                </div>
                {children}
            </div>
        </header>
    );
}

export function StatPill({
    label,
    value,
    tone,
}: {
    label: string;
    value: number | string;
    tone: "emerald" | "amber" | "red" | "cyan" | "muted";
}) {
    // allow-palette: categorical status colors
    const color = {
        emerald: "text-emerald-200",
        amber: "text-amber-200",
        red: "text-red-300",
        cyan: "text-cyan-200",
        muted: "text-muted-foreground",
    }[tone];

    return (
        <span className="flex items-center gap-2 px-2.5 py-1">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn("font-bold", color)}>{value}</span>
        </span>
    );
}
