import { Separator } from "@ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@ui/components/sidebar";
import { cn } from "@ui/lib/utils";
import { ThemeProvider } from "@ui/theme/provider";
import type React from "react";
import { GlowOrbsNexus } from "./glow-orbs";

interface AppShellProps {
    sidebar: React.ReactNode;
    title?: string;
    description?: string;
    statusLabel?: string;
    /** Ambient bloom. Default "subtle" (dashboard / DashboardLayout-safe, no
     *  perf cost). "rich" = colorful sign-in-style static bloom. "rich-animated"
     *  = +pulse (low-cost single-purpose pages only — see GlowOrbsNexus). */
    glowVariant?: "subtle" | "rich" | "rich-animated";
    /** Token theme class applied to the shell root (e.g. "cyberpunk", "wow").
     *  Pins token values regardless of ambient; default inherits (dashboard). */
    themeClass?: string;
    gridBackground?: boolean;
    scanLinesEffect?: boolean;
    children: React.ReactNode;
}

export function AppShell({
    sidebar,
    title,
    description,
    statusLabel = "System Online",
    glowVariant = "subtle",
    themeClass,
    gridBackground,
    scanLinesEffect,
    children,
}: AppShellProps) {
    return (
        <ThemeProvider variant="nexus">
            <SidebarProvider className={cn("nexus", themeClass)}>
                <div className="fixed inset-0 -z-20 bg-background pointer-events-none" />
                <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
                    <GlowOrbsNexus variant={glowVariant} />
                </div>
                {gridBackground && (
                    <div className="fixed inset-0 -z-10 cyber-grid opacity-[0.35] pointer-events-none" />
                )}
                {scanLinesEffect && (
                    <div className="fixed inset-0 z-50 scan-lines opacity-[0.04] pointer-events-none" />
                )}

                {sidebar}
                <SidebarInset className="bg-transparent">
                    <header className="sticky top-0 z-10 flex min-h-16 items-center gap-3 border-b border-primary/20 bg-background/70 backdrop-blur-xl px-4 py-2.5">
                        <SidebarTrigger className="size-9 p-2 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors rounded-lg shrink-0" />
                        <Separator orientation="vertical" className="h-6 bg-amber-500/20 shrink-0" />
                        {title && (
                            <div className="flex flex-col justify-center leading-tight">
                                <h1 className="text-sm font-semibold tracking-tight gradient-text">{title}</h1>
                                {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
                            </div>
                        )}

                        <div className="ml-auto flex items-center gap-2">
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="uppercase tracking-widest">{statusLabel}</span>
                            </div>
                        </div>
                    </header>

                    <main className="flex-1 p-6">{children}</main>
                </SidebarInset>
            </SidebarProvider>
        </ThemeProvider>
    );
}
