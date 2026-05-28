import { useScrollProgress } from "@app/utils/ui/hooks/useScrollProgress.client";
import type { ReactNode } from "react";
import { LiveSseIndicator } from "./LiveSseIndicator";
import { QaSoundWrench } from "./QaSoundWrench";

interface QaTopBarProps {
    live: boolean;
    count: number;
    search: ReactNode;
    viewToggle: ReactNode;
}

export function QaTopBar({ live, count, search, viewToggle }: QaTopBarProps) {
    const { y } = useScrollProgress();
    const opacity = Math.min(1, 0.55 + y / 240);

    return (
        <header
            className="dd-qa-topbar sticky top-0 z-30 backdrop-blur-sm"
            style={{ ["--dd-topbar-opacity" as never]: opacity }}
        >
            <div className="flex flex-wrap items-center gap-3 px-4 py-2">
                <div className="flex items-center gap-3">
                    {viewToggle}
                    <LiveSseIndicator live={live} count={count} />
                </div>
                <div className="min-w-0 flex-1">{search}</div>
                <QaSoundWrench />
            </div>
        </header>
    );
}
