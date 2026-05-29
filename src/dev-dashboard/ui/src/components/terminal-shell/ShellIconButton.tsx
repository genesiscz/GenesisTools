import { IconTooltip } from "@ui/components/icon-button";
import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

interface Props extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
    icon: LucideIcon;
    label: string;
}

export function ShellIconButton({ icon: Icon, label, className = "", ...props }: Props) {
    return (
        <IconTooltip tooltip={label}>
            <button type="button" className={`dd-shell-icon shrink-0 ${className}`.trim()} {...props}>
                <Icon size={14} />
            </button>
        </IconTooltip>
    );
}
