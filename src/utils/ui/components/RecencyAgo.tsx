import type { ReactElement } from "react";
import { resolveQaRecency } from "@app/utils/ui/helpers/qa-recency";
import { useNowTick } from "@app/utils/ui/hooks/useNowTick";

interface Props {
    ts: number;
    now?: number;
    className?: string;
}

export function RecencyAgo({ ts, now: nowProp, className = "" }: Props): ReactElement {
    const tickNow = useNowTick(1000);
    const now = nowProp ?? tickNow;
    const { tier, relative } = resolveQaRecency(ts, now);

    return <span className={`ui-recency ui-recency--${tier} ${className}`.trim()}>{relative}</span>;
}
