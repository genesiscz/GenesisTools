import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@ui/lib/utils";
import { BriefcaseBusiness, PlaySquare, Settings, Youtube } from "lucide-react";

const links = [
    { to: "/", label: "Channels", icon: Youtube },
    { to: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
    { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });

    return (
        <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r border-primary/20 bg-black/35 p-4 backdrop-blur-xl lg:block">
            <div className="mb-8 flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/10 p-4 neon-border">
                <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
                    <PlaySquare className="size-5" />
                </div>
                <div>
                    <p className="text-xs font-mono uppercase tracking-[0.35em] text-primary">Genesis</p>
                    <h1 className="text-lg font-semibold text-foreground">YouTube AI</h1>
                </div>
            </div>
            <nav className="space-y-2">
                {links.map((item) => {
                    const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.to}
                            to={item.to}
                            className={cn(
                                "group flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition-all duration-200",
                                active
                                    ? "border-primary/40 bg-primary/15 text-primary shadow-[0_0_24px_rgba(245,158,11,0.12)]"
                                    : "border-transparent text-muted-foreground hover:-translate-y-0.5 hover:border-secondary/30 hover:bg-secondary/10 hover:text-secondary"
                            )}
                        >
                            <Icon className="size-4" />
                            <span>{item.label}</span>
                        </Link>
                    );
                })}
            </nav>
        </aside>
    );
}
