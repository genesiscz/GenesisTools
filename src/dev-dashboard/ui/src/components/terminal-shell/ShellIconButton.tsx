import { IconTooltip } from "@ui/components/icon-button";
import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

interface Props extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
    icon: LucideIcon;
    label: string;
    variant?: "default" | "destructive";
}

export function ShellIconButton({ icon: Icon, label, variant = "default", className = "", ...props }: Props) {
    const variantClass = variant === "destructive" ? "dd-shell-icon--destructive" : "";

    return (
        <IconTooltip tooltip={label}>
            <button type="button" className={`dd-shell-icon shrink-0 ${variantClass} ${className}`.trim()} {...props}>
                <Icon size={14} />
            </button>
        </IconTooltip>
    );
}
