import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type React from "react";

type SettingCardTint = "primary" | "accent" | "secondary" | "muted" | "destructive";

const tintMap: Record<SettingCardTint, { border: string; borderHover: string; iconBg: string; iconColor: string }> = {
    primary: {
        border: "border-primary/20",
        borderHover: "hover:border-primary/40",
        iconBg: "bg-primary/10",
        iconColor: "text-primary",
    },
    accent: {
        border: "border-accent/20",
        borderHover: "hover:border-accent/40",
        iconBg: "bg-accent/10",
        iconColor: "text-accent",
    },
    secondary: {
        border: "border-secondary/20",
        borderHover: "hover:border-secondary/40",
        iconBg: "bg-secondary/10",
        iconColor: "text-secondary",
    },
    muted: {
        border: "border-muted/30",
        borderHover: "hover:border-muted/50",
        iconBg: "bg-muted/10",
        iconColor: "text-muted-foreground",
    },
    destructive: {
        border: "border-destructive/20",
        borderHover: "hover:border-destructive/40",
        iconBg: "bg-destructive/10",
        iconColor: "text-destructive",
    },
};

interface SettingCardProps {
    title: string;
    description?: string;
    icon?: React.ReactNode;
    tint?: SettingCardTint;
    children: React.ReactNode;
    className?: string;
}

/**
 * SettingCard — a themed glassmorphic group container for setting rows.
 * Wraps Card with neon tint border, icon badge, title, and description.
 */
export function SettingCard({ title, description, icon, tint = "primary", children, className }: SettingCardProps) {
    const colors = tintMap[tint];

    return (
        <Card
            className={cn(
                colors.border,
                colors.borderHover,
                "bg-card/80 backdrop-blur-sm transition-colors",
                className
            )}
        >
            <CardHeader>
                <div className="flex items-center gap-3">
                    {icon && (
                        <div className={cn("p-2 rounded-lg", colors.iconBg)}>
                            <span className={colors.iconColor}>{icon}</span>
                        </div>
                    )}
                    <div>
                        <CardTitle className="text-base">{title}</CardTitle>
                        {description && <CardDescription className="text-xs">{description}</CardDescription>}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">{children}</CardContent>
        </Card>
    );
}
