export function PanelLoading({ label = "Loading" }: { label?: string }) {
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-primary" />
                {label}…
            </div>
            <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => (
                    <div key={index} className="h-4 animate-pulse rounded-md bg-primary/10" />
                ))}
            </div>
        </div>
    );
}
