import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";

interface ShellProps {
    children: ReactNode;
}

export function Shell({ children }: ShellProps) {
    return (
        <div className="dd-grid-bg flex min-h-screen">
            <aside className="w-[62px] border-r border-[var(--dd-border)] bg-[var(--dd-bg-panel)]">
                <Sidebar />
            </aside>
            <main className="flex-1 p-4">{children}</main>
        </div>
    );
}
