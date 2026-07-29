import type { ReactNode } from "react";

/** The double-bezel Obsidian card used across the dashboard. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
    return (
        <div className={`rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl ${className}`}>
            <div className="inset-hi h-full rounded-[calc(1.75rem-0.375rem)] bg-[#0a0b0d] p-6 ring-1 ring-white/[0.06]">
                {children}
            </div>
        </div>
    );
}

export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div className="mb-6">
            <h1 className="font-display text-2xl font-semibold text-zinc-50">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">{subtitle}</p>}
        </div>
    );
}
