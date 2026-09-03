import { Skeleton } from "@genesiscz/utils/ui/components/skeleton";

export function Loading({ label = "Loading watchers", cards = 6 }: { label?: string; cards?: number }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3 font-mono text-sm uppercase tracking-[0.25em] text-primary">
                <span className="size-2 rounded-full bg-primary shadow-[0_0_16px_rgba(245,158,11,0.8)]" />
                {label}
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: cards }).map((_, index) => (
                    <Skeleton key={index} className="h-56 rounded-3xl bg-primary/10 animate-skeleton-shimmer" />
                ))}
            </div>
        </div>
    );
}

export function ErrorPanel({ title, detail }: { title: string; detail?: string }) {
    return (
        <div className="mon-panel rounded-3xl border border-destructive/30 p-6">
            <p className="text-sm font-semibold text-destructive">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">
                {detail ?? "The API request failed. Check that the monitor server is running, then retry."}
            </p>
        </div>
    );
}
