import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const TICK_MS = 1_000;

const QaClockContext = createContext(Date.now());

export function QaClockProvider({ children }: { children: ReactNode }) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, []);

    return <QaClockContext.Provider value={now}>{children}</QaClockContext.Provider>;
}

function useQaClock(): number {
    return useContext(QaClockContext);
}

export { useQaClock };
