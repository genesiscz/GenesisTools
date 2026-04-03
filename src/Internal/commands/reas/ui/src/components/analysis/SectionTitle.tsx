import type { ReactNode } from "react";

interface SectionTitleProps {
    title: string;
    subtitle?: string;
    actions?: ReactNode;
}

export function SectionTitle({ title, subtitle, actions }: SectionTitleProps) {
    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
                <h3 className="text-sm font-mono uppercase tracking-[0.24em] text-white">{title}</h3>
                {subtitle ? <p className="text-xs font-mono leading-5 text-slate-500">{subtitle}</p> : null}
            </div>
            {actions ? <div>{actions}</div> : null}
        </div>
    );
}
