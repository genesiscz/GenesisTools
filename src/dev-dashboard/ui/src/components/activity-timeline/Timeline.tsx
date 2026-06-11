import type { TimelineEvent } from "@app/dev-dashboard/lib/timeline/types";
import { EventRow } from "@/components/activity-timeline/EventRow";
import { groupByHour } from "@/components/activity-timeline/units";

interface Props {
    events: TimelineEvent[];
}

/**
 * The cross-source "today on this machine" feed: daemon runs + agent Q&A + terminal launches, grouped
 * into descending hour buckets. Web parity with the mobile Timeline — each hour is a dd-panel card
 * with its event rows below a "HH:00" header.
 */
export function Timeline({ events }: Props) {
    if (events.length === 0) {
        return (
            <div className="dd-panel p-4 text-sm text-[var(--dd-text-muted)]">
                Nothing happened yet today. Runs, Q&A, and terminals will appear here.
            </div>
        );
    }

    const groups = groupByHour(events);

    return (
        <div className="flex flex-col gap-4">
            {groups.map((group) => (
                <div key={group.hourKey} className="flex flex-col gap-2">
                    <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--dd-text-secondary)]">
                        {group.label}
                    </h2>
                    <div className="dd-panel flex flex-col divide-y divide-[var(--dd-border)] p-4">
                        {group.events.map((event) => (
                            <EventRow key={event.id} event={event} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
