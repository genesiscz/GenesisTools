import { Skeleton } from "@app/utils/ui/components/skeleton";

export function Loading({ label = "Loading signal" }: { label?: string }) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm font-mono uppercase tracking-[0.25em] text-primary">
                <span className="size-2 rounded-full bg-primary shadow-[0_0_16px_rgba(245,158,11,0.8)]" />
                {label}
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} className="h-44 rounded-2xl bg-primary/10 animate-skeleton-shimmer" />
                ))}
            </div>
        </div>
    );
}
