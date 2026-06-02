import type { TimelineEvent } from "@app/dev-dashboard/lib/timeline/types";
import { Cpu, MessageSquare, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { eventTime, eventVisual } from "@/components/activity-timeline/units";

interface Props {
    event: TimelineEvent;
}

const ICON_FOR: Record<TimelineEvent["type"], ComponentType<{ size?: number; color?: string }>> = {
    run: Cpu,
    qa: MessageSquare,
    terminal: Terminal,
};

/**
 * One timeline event row (web parity with the mobile EventRow): leading local time + a type-colored
 * icon, the title + dim subtitle, and a trailing type pill. Styled with the shared dd-* tokens.
 */
export function EventRow({ event }: Props) {
    const visual = eventVisual(event);
    const Icon = ICON_FOR[event.type];

    return (
        <div className="flex items-start gap-3 py-2">
            <span className="w-12 shrink-0 font-mono text-xs text-[var(--dd-text-muted)]">{eventTime(event.ts)}</span>
            <span
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--dd-border)]"
                style={{ background: "var(--dd-bg-panel)" }}
            >
                <Icon size={12} color={visual.color} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-sm text-[var(--dd-text-primary)]">{event.title}</span>
                {event.subtitle ? (
                    <span className="truncate font-mono text-xs text-[var(--dd-text-muted)]">{event.subtitle}</span>
                ) : null}
            </span>
            <span
                className="shrink-0 rounded-full border border-[var(--dd-border)] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest"
                style={{ color: visual.color }}
            >
                {visual.pillLabel}
            </span>
        </div>
    );
}
