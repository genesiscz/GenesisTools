import { formatClock } from "@genesiscz/utils/format";
import { resolveQaRecency } from "@genesiscz/utils/ui/helpers/qa-recency";
import { memo } from "react";
import { useQaClock } from "@/components/QaClockProvider";

interface QaRecencyTimeProps {
    ts: number;
}

export const QaRecencyTime = memo(function QaRecencyTime({ ts }: QaRecencyTimeProps) {
    // One string, so the row re-renders only when the tier or the label moves.
    const recency = useQaClock((now) => {
        const { tier, relative } = resolveQaRecency(ts, now);
        return `${tier} ${relative}`;
    });
    const tierEnd = recency.indexOf(" ");
    const tier = recency.slice(0, tierEnd);
    const relative = recency.slice(tierEnd + 1);
    const when = new Date(ts);
    const absolute = formatClock(when, { date: "short", seconds: true });

    return (
        <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 tabular-nums">
            <span className={`ui-recency ui-recency--${tier}`}>{relative}</span>
            <span className="text-[var(--dd-text-muted)]">·</span>
            <time className="text-[var(--dd-text-muted)]" dateTime={when.toISOString()}>
                {absolute}
            </time>
        </span>
    );
});
