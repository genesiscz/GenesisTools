interface KpiCardProps {
    label: string;
    value: string;
    sub?: string;
}

export function KpiCard({ label, value, sub }: KpiCardProps) {
    return (
        <div className="dd-panel flex flex-col gap-1 p-4">
            <span className="text-xs font-mono uppercase tracking-widest" style={{ color: "var(--dd-text-muted)" }}>
                {label}
            </span>
            <span className="text-2xl font-bold font-mono" style={{ color: "var(--dd-text-primary)" }}>
                {value}
            </span>
            {sub ? (
                <span className="text-xs font-mono" style={{ color: "var(--dd-text-secondary)" }}>
                    {sub}
                </span>
            ) : null}
        </div>
    );
}
