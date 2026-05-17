import { cn } from "@ui/lib/utils";
import type React from "react";

interface MetaItemProps {
    icon: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

export function MetaItem({ icon, children, className }: MetaItemProps) {
    return (
        <div className={cn("flex items-center gap-1.5", className)}>
            <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
            <span>{children}</span>
        </div>
    );
}

export function MetaRow({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn("flex items-center gap-4 text-xs text-muted-foreground", className)}>{children}</div>;
}
