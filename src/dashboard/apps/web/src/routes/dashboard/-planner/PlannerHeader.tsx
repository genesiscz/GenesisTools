import { ViewModeToggle } from "@ui/custom";
import { Calendar, LayoutList } from "lucide-react";

export type PlannerView = "day" | "list";

interface PlannerHeaderProps {
    view: PlannerView;
    onViewChange: (v: PlannerView) => void;
    scheduledCount: number;
    inboxCount: number;
}

const PLANNER_MODES = [
    { value: "day" as const, label: "Day", icon: Calendar },
    { value: "list" as const, label: "List", icon: LayoutList },
];

function todayLabel(): string {
    return new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
    });
}

export function PlannerHeader({ view, onViewChange, scheduledCount, inboxCount }: PlannerHeaderProps) {
    return (
        <div
            className={[
                "flex items-center justify-between rounded-xl border border-white/5 px-5 py-3",
                "bg-zinc-900/60 backdrop-blur-md",
            ].join(" ")}
        >
            <div>
                <h2 className="text-base font-semibold text-zinc-100">Daily Planner</h2>
                <p className="text-xs text-zinc-500" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {todayLabel()} &middot; {scheduledCount} scheduled &middot; {inboxCount} in inbox
                </p>
            </div>

            <ViewModeToggle
                modes={PLANNER_MODES}
                value={view}
                onChange={onViewChange}
                className="border-white/10 bg-zinc-800/60"
            />
        </div>
    );
}
