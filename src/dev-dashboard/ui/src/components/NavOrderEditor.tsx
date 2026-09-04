import { IconPopover } from "@ui/components/icon-button";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { useNavOrder } from "@/hooks/useNavOrder";
import "@/components/ai-accounts/ai-accounts.css";

/**
 * Sidebar order editor: a popover listing every nav route with move up, move
 * down and reset. Keyboard and pointer friendly without a drag library; a drag
 * layer can be added on top later without changing the persisted shape.
 */
export function NavOrderEditor() {
    const { routes, moveBy, reset, isCustom } = useNavOrder();

    return (
        <IconPopover
            tooltip="Reorder sidebar"
            trigger={
                <button
                    type="button"
                    aria-label="Reorder sidebar"
                    className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] border border-[var(--dd-border)] text-[var(--dd-text-secondary)] transition hover:text-[var(--dd-text-primary)]"
                >
                    <GripVertical size={14} />
                </button>
            }
        >
            <div className="flex w-56 flex-col gap-1 p-1">
                <div className="flex items-center justify-between px-1 pb-1">
                    <span className="text-xs text-[var(--dd-text-muted)]">Sidebar order</span>
                    {isCustom ? (
                        <button
                            type="button"
                            className="text-xs text-[var(--dd-text-muted)] underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                            onClick={reset}
                        >
                            reset
                        </button>
                    ) : null}
                </div>
                {routes.map(({ to, label, Icon }, index) => (
                    <div key={to} className="dd-ai-block flex items-center gap-2 rounded-md px-1 py-0.5">
                        <span className="flex h-5 w-5 items-center justify-center text-[var(--dd-text-secondary)]">
                            <Icon size={12} />
                        </span>
                        <span className="flex-1 truncate text-xs text-[var(--dd-text-primary)]">{label}</span>
                        <span className="dd-ai-block-tools flex items-center gap-1">
                            <button
                                type="button"
                                className="dd-ai-tool-btn"
                                aria-label={`Move ${label} up`}
                                disabled={index === 0}
                                onClick={() => moveBy(to, -1)}
                            >
                                <ChevronUp size={12} />
                            </button>
                            <button
                                type="button"
                                className="dd-ai-tool-btn"
                                aria-label={`Move ${label} down`}
                                disabled={index === routes.length - 1}
                                onClick={() => moveBy(to, 1)}
                            >
                                <ChevronDown size={12} />
                            </button>
                        </span>
                    </div>
                ))}
            </div>
        </IconPopover>
    );
}
