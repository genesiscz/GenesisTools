import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";
import { Loader2 } from "lucide-react";

const KIND_STYLES: Record<string, string> = {
    web: "border-[var(--dd-accent)]/40 text-[var(--dd-accent)]",
    api: "border-emerald-500/40 text-emerald-400",
    "genesis-tools": "border-violet-500/40 text-violet-300",
    other: "border-[var(--dd-border)] text-[var(--dd-text-muted)]",
};

export function PortKindBadge({ port }: { port: PortInfo }) {
    if (port.probeStatus === "pending") {
        return (
            <span
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-[var(--dd-text-muted)]"
                title="Probing…"
            >
                <Loader2 className="h-3 w-3 animate-spin" />…
            </span>
        );
    }

    if (port.visibility === "system") {
        return (
            <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--dd-text-muted)]">system</span>
        );
    }

    if (port.visibility === "junk") {
        return <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--dd-text-muted)]">junk</span>;
    }

    const kind = port.kind ?? "other";
    const label = kind === "genesis-tools" ? "genesis" : kind === "web" ? "web" : kind === "api" ? "api" : "other";

    return (
        <span
            className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${KIND_STYLES[kind] ?? KIND_STYLES.other}`}
        >
            {label}
        </span>
    );
}
