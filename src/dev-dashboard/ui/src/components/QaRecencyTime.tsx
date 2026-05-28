import { resolveQaRecency } from "@app/utils/ui/helpers/qa-recency";
import { formatClock } from "@app/utils/format";
import { memo } from "react";
import { useQaClock } from "@/components/QaClockProvider";

interface QaRecencyTimeProps {
    ts: number;
}

export const QaRecencyTime = memo(function QaRecencyTime({ ts }: QaRecencyTimeProps) {
    const now = useQaClock();
    const when = new Date(ts);
    const { tier, relative } = resolveQaRecency(ts, now);
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
