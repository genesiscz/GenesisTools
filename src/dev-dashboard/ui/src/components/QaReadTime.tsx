import { formatElapsedDhM } from "@app/utils/format";
import { memo } from "react";
import { useQaClock } from "@/components/QaClockProvider";

interface QaReadTimeProps {
    readAt: number;
}

export const QaReadTime = memo(function QaReadTime({ readAt }: QaReadTimeProps) {
    const now = useQaClock();
    const elapsed = formatElapsedDhM(now - readAt);

    return (
        <span className="text-[var(--dd-text-muted)] tabular-nums" title="Marked read">
            read {elapsed} ago
        </span>
    );
});
