import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { DirPath } from "@ui/components/DirPath";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { ReactElement } from "react";
import { formatSessionHeaderParts } from "@/lib/session-run-context";

export type SessionHeaderLayout = "stacked" | "inline" | "context";

interface Props {
    session: DashboardSession;
    className?: string;
    onNameClick?: () => void;
    showCommand?: boolean;
    layout?: SessionHeaderLayout;
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
    layout = "stacked",
}: Props): ReactElement {
    const parts = formatSessionHeaderParts(session);
    const nameClass = onNameClick
        ? "shrink-0 whitespace-nowrap hover:text-cyan-300 text-left transition-colors"
        : "shrink-0 whitespace-nowrap";
    const secondary = [parts.cwd, showCommand ? parts.command : undefined].filter(Boolean);

    if (layout === "context") {
        if (secondary.length === 0) {
            return null;
        }

        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <div
                        className={`dbg-header-text inline-flex flex-wrap items-baseline gap-x-1 min-w-0 text-white/50 font-mono ${className}`}
                    >
                        {parts.cwd ? <DirPath path={parts.cwd} className="min-w-0" /> : null}
                        {parts.cwd && showCommand && parts.command ? (
                            <span className="text-white/20 shrink-0">·</span>
                        ) : null}
                        {showCommand && parts.command ? (
                            <span className="text-cyan-300/70 shrink-0">{parts.command}</span>
                        ) : null}
                    </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-lg break-all">{parts.title}</TooltipContent>
            </Tooltip>
        );
    }

    if (layout === "inline") {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <div
                        className={`dbg-header-text flex items-center gap-1 min-w-0 font-mono leading-snug ${className}`}
                    >
                        <span className={`uppercase tracking-wider shrink-0 font-semibold ${badgeClass(parts.badge)}`}>
                            [{parts.badge}]
                        </span>
                        {onNameClick ? (
                            <button
                                type="button"
                                onClick={onNameClick}
                                className={`${nameClass} font-medium text-white/95`}
                            >
                                {parts.name}
                            </button>
                        ) : (
                            <span className={`${nameClass} text-white/90`}>{parts.name}</span>
                        )}
                        {parts.cwd ? (
                            <>
                                <span className="text-white/20 shrink-0">·</span>
                                <DirPath path={parts.cwd} className="min-w-0 flex-1 text-white/50" />
                            </>
                        ) : null}
                        {showCommand && parts.command ? (
                            <>
                                <span className="text-white/20 shrink-0">·</span>
                                <span className="truncate-mono min-w-0 shrink text-cyan-300/75">{parts.command}</span>
                            </>
                        ) : null}
                    </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-lg break-all">{parts.title}</TooltipContent>
            </Tooltip>
        );
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className={`dbg-header-text dbg-header-stacked min-w-0 font-mono ${className}`}>
                    <span className={`uppercase tracking-wider shrink-0 font-semibold ${badgeClass(parts.badge)}`}>
                        [{parts.badge}]
                    </span>
                    {onNameClick ? (
                        <button
                            type="button"
                            onClick={onNameClick}
                            className={`${nameClass} font-semibold text-white/95`}
                        >
                            {parts.name}
                        </button>
                    ) : (
                        <span className={`${nameClass} font-semibold text-white/90`}>{parts.name}</span>
                    )}
                    {secondary.length > 0 ? (
                        <div className="dbg-header-stacked__meta">
                            {parts.cwd ? <DirPath path={parts.cwd} /> : null}
                            {parts.cwd && showCommand && parts.command ? (
                                <span className="text-white/20 shrink-0">·</span>
                            ) : null}
                            {showCommand && parts.command ? (
                                <span className="truncate-mono min-w-0 shrink text-cyan-300/70">{parts.command}</span>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-lg break-all">{parts.title}</TooltipContent>
        </Tooltip>
    );
}
