import { cn } from "@ui/lib/utils";
import { Calendar, Clock } from "lucide-react";
import { MetaItem, MetaRow } from "./meta-item";

interface TaskMetaRowProps {
    deadline?: string;
    focusTimeLabel?: string;
    size?: "xs" | "sm";
    deadlineClassName?: string;
    focusTimeClassName?: string;
    className?: string;
}

export function TaskMetaRow({
    deadline,
    focusTimeLabel,
    size = "sm",
    deadlineClassName,
    focusTimeClassName,
    className,
}: TaskMetaRowProps) {
    const iconClass = size === "xs" ? "[&_svg]:h-3 [&_svg]:w-3" : undefined;
    const textSize = size === "xs" ? "text-[10px]" : "text-xs";

    return (
        <MetaRow className={cn(textSize, className)}>
            {deadline && (
                <MetaItem icon={<Calendar />} className={iconClass}>
                    <span className={deadlineClassName}>{deadline}</span>
                </MetaItem>
            )}
            {focusTimeLabel && (
                <MetaItem icon={<Clock />} className={iconClass}>
                    <span className={focusTimeClassName}>{focusTimeLabel}</span>
                </MetaItem>
            )}
        </MetaRow>
    );
}
