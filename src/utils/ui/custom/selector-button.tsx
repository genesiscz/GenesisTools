import { Button } from "@ui/components/button";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface SelectorButtonProps {
    selected: boolean;
    onClick: () => void;
    icon?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    layout?: "row" | "column";
    selectedClassName?: string;
    className?: string;
}

export function SelectorButton({
    selected,
    onClick,
    icon,
    title,
    description,
    layout = "row",
    selectedClassName = "border-purple-500 bg-purple-500/10 text-purple-300",
    className,
}: SelectorButtonProps) {
    return (
        <Button
            type="button"
            variant="outline"
            onClick={onClick}
            className={cn(
                "h-auto gap-3 p-3 border-white/10 hover:bg-white/5 whitespace-normal",
                layout === "row" ? "justify-start text-left" : "flex-col items-center justify-center text-center",
                selected && selectedClassName,
                className
            )}
        >
            {icon && <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>}
            <span className="min-w-0">
                <span className="block font-medium">{title}</span>
                {description && <span className="block text-xs text-muted-foreground">{description}</span>}
            </span>
        </Button>
    );
}
