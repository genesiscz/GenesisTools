import type { ReactElement } from "react";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatSessionHeaderParts } from "@/lib/session-run-context";

interface Props {
    session: DashboardSession;
    className?: string;
    onNameClick?: () => void;
    showCommand?: boolean;
}

function badgeClass(badge: string): string {
    if (badge === "task") {
        return "text-cyan-300/90";
    }

    return "text-purple-300/90";
}

export function SessionHeaderLine({
    session,
    className = "",
    onNameClick,
    showCommand = true,
}: Props): ReactElement {
    const parts = formatSessionHeaderParts(session);
    const nameClass = onNameClick
        ? "hover:text-cyan-300 truncate-mono min-w-0 shrink text-left"
        : "truncate-mono min-w-0 shrink";

    return (
        <div
            className={`dbg-header-text flex items-center gap-1 min-w-0 font-mono leading-snug ${className}`}
            title={parts.title}
        >
            <span className={`uppercase tracking-wider shrink-0 ${badgeClass(parts.badge)}`}>[{parts.badge}]</span>
            {onNameClick ? (
                <button type="button" onClick={onNameClick} className={`${nameClass} font-medium text-white/95`}>
                    {parts.name}
                </button>
            ) : (
                <span className={`${nameClass} text-white/90`}>{parts.name}</span>
            )}
            {parts.cwd ? (
                <>
                    <span className="text-white/25 shrink-0">·</span>
                    <span className="truncate-mono min-w-0 shrink text-white/55">{parts.cwd}</span>
                </>
            ) : null}
            {showCommand && parts.command ? (
                <>
                    <span className="text-white/25 shrink-0">·</span>
                    <span className="truncate-mono min-w-0 shrink text-cyan-300/80">{parts.command}</span>
                </>
            ) : null}
        </div>
    );
}
