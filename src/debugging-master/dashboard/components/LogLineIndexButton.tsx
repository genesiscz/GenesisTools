import { IconTooltip } from "@ui/components/icon-button";
import { Crosshair } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import {
    formatLogLineIndex,
    LOG_LINE_JUMP_CLEAR_TOOLTIP,
    LOG_LINE_JUMP_TOOLTIP,
} from "@/lib/log-line-index";

interface Props {
    index: number;
    isJumpTarget: boolean;
    onJump: (index: number) => void;
    onClearJump: () => void;
    className?: string;
    compact?: boolean;
    disabled?: boolean;
    tooltip?: string;
}

export function LogLineIndexButton({
    index,
    isJumpTarget,
    onJump,
    onClearJump,
    className = "",
    compact = false,
    disabled = false,
    tooltip: tooltipOverride,
}: Props): ReactElement {
    const label = formatLogLineIndex(index);
    const tooltip =
        tooltipOverride ?? (isJumpTarget ? LOG_LINE_JUMP_CLEAR_TOOLTIP : LOG_LINE_JUMP_TOOLTIP);

    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();

        if (disabled) {
            return;
        }

        if (isJumpTarget) {
            onClearJump();
            return;
        }

        onJump(index);
    };

    return (
        <span className={`dbg-log-line__id inline-flex items-center gap-0.5 shrink-0 ${className}`.trim()}>
            <IconTooltip tooltip={disabled ? label : tooltip}>
                <button
                    type="button"
                    onClick={handleClick}
                    disabled={disabled}
                    className={`dbg-log-line__id-btn tabular-nums transition-colors ${
                        isJumpTarget
                            ? "text-amber-300/95 hover:text-amber-200"
                            : disabled
                              ? "text-white/25 cursor-default"
                              : "text-white/40 hover:text-cyan-300/90"
                    }`}
                    aria-current={isJumpTarget ? "true" : undefined}
                >
                    {label}
                </button>
            </IconTooltip>
            {compact ? null : (
                <IconTooltip tooltip={disabled ? label : tooltip}>
                    <button
                        type="button"
                        onClick={handleClick}
                        disabled={disabled}
                        className={`dbg-log-line__id-jump inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                            isJumpTarget
                                ? "border-amber-400/40 text-amber-300/90 hover:border-amber-300/60"
                                : "border-white/10 text-white/35 hover:text-cyan-300/80 hover:border-cyan-500/35"
                        }`}
                        aria-label={tooltip}
                    >
                        <Crosshair className="w-2.5 h-2.5" />
                    </button>
                </IconTooltip>
            )}
        </span>
    );
}
