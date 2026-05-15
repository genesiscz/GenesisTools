import { Separator } from "@ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@ui/components/sidebar";
import type React from "react";

interface AppShellProps {
    sidebar: React.ReactNode;
    title?: string;
    description?: string;
    statusLabel?: string;
    gridBackground?: boolean;
    scanLinesEffect?: boolean;
    children: React.ReactNode;
}

export function AppShell({
    sidebar,
    title,
    description,
    statusLabel = "System Online",
    gridBackground,
    scanLinesEffect,
    children,
}: AppShellProps) {
    return (
        <SidebarProvider>
            {gridBackground && <div className="fixed inset-0 cyber-grid opacity-40 pointer-events-none" />}
            {scanLinesEffect && <div className="fixed inset-0 scan-lines opacity-30 pointer-events-none" />}

            {sidebar}
            <SidebarInset className="bg-transparent">
                <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-amber-500/10 bg-[#030308]/70 backdrop-blur-xl px-4">
                    <SidebarTrigger className="size-9 p-2 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors rounded-lg" />
                    <Separator orientation="vertical" className="h-4 bg-amber-500/20" />
                    {title && (
                        <div className="flex flex-col">
                            <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
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
    );
}
