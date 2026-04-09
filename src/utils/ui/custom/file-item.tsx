import { cn } from "@ui/lib/utils";
import { FileText } from "lucide-react";
import type React from "react";

const variants = {
    default: "bg-white/[0.03] border-white/5 hover:bg-white/[0.06] hover:border-white/10",
    active: "bg-violet-500/10 border-violet-500/30",
    success: "bg-emerald-500/5 border-emerald-500/20",
};

const textVariants = {
    default: "text-zinc-400",
    active: "text-violet-300 font-medium",
    success: "text-zinc-300",
};

const iconVariants = {
    default: "text-zinc-500",
    active: "text-violet-400",
    success: "text-emerald-400",
};

type FileItemVariant = keyof typeof variants;

interface FileItemProps {
    name: string;
    size?: string;
    icon?: React.ReactNode;
    variant?: FileItemVariant;
    rightElement?: React.ReactNode;
    onClick?: () => void;
    className?: string;
}

export function FileItem({ name, size, icon, variant = "default", rightElement, onClick, className }: FileItemProps) {
    const rowClass = cn(
        "flex w-full items-center gap-3 px-3.5 py-2.5 rounded-[10px] border text-left transition-all duration-200",
        variants[variant],
        className
    );

    const content = (
        <>
            <div className={cn("size-4 flex-shrink-0", iconVariants[variant])}>
                {icon ?? <FileText className="w-full h-full" />}
            </div>
            <span className={cn("text-sm flex-1 truncate", textVariants[variant])}>{name}</span>
            {size && <span className="text-xs text-muted-foreground flex-shrink-0">{size}</span>}
            {rightElement}
        </>
    );

    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={cn(rowClass, "cursor-pointer")}>
                {content}
            </button>
        );
    }

    return <div className={rowClass}>{content}</div>;
}
