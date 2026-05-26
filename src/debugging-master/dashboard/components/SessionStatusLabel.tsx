import type { ReactElement } from "react";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { useEffect, useMemo, useState } from "react";
import { formatDashboardSessionStatusLabel } from "@/lib/session-status-label";

interface Props {
    session: DashboardSession;
    latestLineTs?: number;
    className?: string;
}

export function SessionStatusLabel({ session, latestLineTs, className }: Props): ReactElement {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = setInterval(() => {
            setNow(Date.now());
        }, 1000);

        return () => {
            clearInterval(id);
        };
    }, []);

    const label = useMemo(() => {
        return formatDashboardSessionStatusLabel({ session, now, latestLineTs });
    }, [session, now, latestLineTs]);

    return <span className={className}>{label}</span>;
}
