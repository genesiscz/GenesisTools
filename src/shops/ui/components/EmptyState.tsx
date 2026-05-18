import { Card, CardContent } from "@app/utils/ui/components/card";
import type { ReactNode } from "react";

interface EmptyStateProps {
    title: string;
    body: string;
    icon?: ReactNode;
    action?: ReactNode;
}

export function EmptyState({ title, body, icon, action }: EmptyStateProps) {
    return (
        <Card className="border-dashed border-border bg-transparent shadow-none">
            <CardContent className="py-16 px-6 flex flex-col items-center text-center gap-3">
                {icon && (
                    <div className="text-[var(--color-neon-cyan)] opacity-60 [&>svg]:w-10 [&>svg]:h-10">{icon}</div>
                )}
                <h3 className="font-mono text-sm tracking-[0.2em] text-foreground uppercase">{title}</h3>
                <p className="text-xs text-muted-foreground max-w-md">{body}</p>
                {action && <div className="mt-2">{action}</div>}
            </CardContent>
        </Card>
    );
}
