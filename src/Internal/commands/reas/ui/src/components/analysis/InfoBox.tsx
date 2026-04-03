import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { INFO_BOX_TONE_STYLES, type InfoBoxTone } from "./shared";

interface InfoBoxProps {
    title?: string;
    tone?: InfoBoxTone;
    children: ReactNode;
    className?: string;
}

export function InfoBox({ title, tone = "info", children, className }: InfoBoxProps) {
    return (
        <div className={cn("rounded-xl border px-4 py-3", INFO_BOX_TONE_STYLES[tone], className)}>
            {title ? <div className="text-[10px] font-mono uppercase tracking-[0.24em] opacity-80">{title}</div> : null}
            <div className={cn("text-sm font-mono leading-6", title ? "mt-2" : undefined)}>{children}</div>
        </div>
    );
}
