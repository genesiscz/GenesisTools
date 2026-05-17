import { StatTile } from "@ui/custom";
import { Clock, Flame, Target } from "lucide-react";

interface FocusStatsRowProps {
    timeFocusedTodayMs: number;
    sessionsToday: number;
    dayStreak: number;
}

function formatHMS(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function FocusStatsRow({ timeFocusedTodayMs, sessionsToday, dayStreak }: FocusStatsRowProps) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto w-full">
            <StatTile
                icon={<Clock />}
                value={formatHMS(timeFocusedTodayMs)}
                label="FOCUSED TODAY"
                valueColor="text-amber-400"
            />
            <StatTile
                icon={<Target />}
                value={sessionsToday.toString()}
                label="POMODOROS"
                valueColor="text-purple-400"
            />
            <StatTile icon={<Flame />} value={dayStreak.toString()} label="DAY STREAK" valueColor="text-rose-400" />
        </div>
    );
}
