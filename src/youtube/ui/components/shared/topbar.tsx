import { pageTitleFromPath } from "@app/yt/lib/theme";
import { useEventStream } from "@app/yt/ws.client";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Menu, Sparkles } from "lucide-react";

export function Topbar() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { connected } = useEventStream({ enabled: pathname !== "/first-run" });

    return (
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-primary/20 bg-background/78 px-4 backdrop-blur-xl lg:px-6">
            <div className="flex items-center gap-3">
                <Link
                    to="/"
                    className="grid size-10 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary lg:hidden"
                >
                    <Menu className="size-5" />
                </Link>
                <div>
                    <p className="font-mono text-[0.65rem] uppercase tracking-[0.32em] text-secondary">
                        YouTube Pipeline
                    </p>
                    <h2 className="text-xl font-semibold tracking-tight">{pageTitleFromPath(pathname)}</h2>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <div className="hidden items-center gap-2 rounded-full border border-secondary/25 bg-secondary/10 px-3 py-1.5 text-xs font-mono text-secondary sm:flex">
                    <Sparkles className="size-3.5" />
                    cyberpunk
                </div>
                <div className="flex items-center gap-2 rounded-full border border-primary/20 bg-black/25 px-3 py-1.5 text-xs font-mono">
                    <span
                        className={
                            connected
                                ? "size-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]"
                                : "size-2 rounded-full bg-muted-foreground"
                        }
                    />
                    <Activity className="size-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">{connected ? "live" : "polling"}</span>
                </div>
            </div>
        </header>
    );
}
