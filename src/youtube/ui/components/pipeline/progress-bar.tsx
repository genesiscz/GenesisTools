import { Progress } from "@app/utils/ui/components/progress";

export function ProgressBar({
    value = 0,
    label = "Pipeline progress",
    message = null,
}: {
    videoId?: string;
    value?: number;
    label?: string;
    message?: string | null;
}) {
    const fraction = value > 1 ? value : value * 100;
    const normalized = Math.max(0, Math.min(100, Math.round(fraction)));
    const isActive = normalized > 0 && normalized < 100;

    return (
        <div className="rounded-2xl border border-primary/20 bg-black/25 p-4">
            <div className="mb-2 flex items-center justify-between font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                <span>{label}</span>
                <span className="text-primary">{normalized}%</span>
            </div>
            <Progress
                value={normalized}
                className={`h-3 bg-black/40 [&>div]:bg-gradient-to-r [&>div]:from-primary [&>div]:to-secondary ${isActive ? "[&>div]:animate-pulse" : ""}`}
            />
            {message ? <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">{message}</p> : null}
        </div>
    );
}
