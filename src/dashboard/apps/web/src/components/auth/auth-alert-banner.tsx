import { cn } from "@ui/lib/utils";
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import type React from "react";

type AlertVariant = "error" | "warning" | "success" | "info";

const variantStyles: Record<
    AlertVariant,
    { bg: string; border: string; text: string; Icon: React.ComponentType<{ className?: string }> }
> = {
    error: {
        bg: "bg-red-500/10",
        border: "border-red-500/20",
        text: "text-red-400",
        Icon: AlertCircle,
    },
    warning: {
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/20",
        text: "text-yellow-400",
        Icon: TriangleAlert,
    },
    success: {
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/20",
        text: "text-emerald-400",
        Icon: CheckCircle2,
    },
    info: {
        bg: "bg-blue-500/10",
        border: "border-blue-500/20",
        text: "text-blue-400",
        Icon: Info,
    },
};

interface AuthAlertBannerProps {
    variant?: AlertVariant;
    message: string;
    className?: string;
}

/**
 * AuthAlertBanner — inline alert banner for auth forms.
 * Supports error/warning/success/info variants with static neon tints.
 */
export function AuthAlertBanner({ variant = "error", message, className }: AuthAlertBannerProps) {
    const styles = variantStyles[variant];
    const { Icon } = styles;

    return (
        <div
            className={cn(
                "flex items-center gap-2 p-3 rounded-lg border text-sm",
                styles.bg,
                styles.border,
                styles.text,
                className
            )}
        >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{message}</span>
        </div>
    );
}
