import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

interface Props extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
    icon: LucideIcon;
    label: string;
}

export function ShellIconButton({ icon: Icon, label, className = "", ...props }: Props) {
    return (
        <button
            type="button"
            className={`dd-shell-icon shrink-0 ${className}`.trim()}
            aria-label={label}
            title={label}
            {...props}
        >
            <Icon size={14} />
        </button>
    );
}
