import { Card } from "@ui/components/card";
import { CalendarCheck, Flame, Smile } from "lucide-react";
import type React from "react";
import type { MoodInsights } from "@/lib/mood/hooks/useMood";
import { moodMeta } from "@/lib/mood/mood-scale";

interface MoodStatsProps {
    insights: MoodInsights;
}

export function MoodStats({ insights }: MoodStatsProps) {
    const avg = insights.avgMoodWeek;
    const avgMeta = avg !== null ? moodMeta(avg) : null;

    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
                testId="mood-stat-avg-week"
                icon={<Smile className="h-4 w-4" />}
                value={avg !== null ? avg.toFixed(1) : "—"}
                suffix={avgMeta ? avgMeta.emoji : undefined}
                label="Avg mood · 7d"
                accent={avgMeta?.color ?? "var(--primary)"}
            />
            <StatTile
                testId="mood-stat-streak"
                icon={<Flame className="h-4 w-4" />}
                value={String(insights.streak)}
                suffix={insights.streak > 0 ? "🔥" : undefined}
                label={insights.streak === 1 ? "Day streak" : "Day streak"}
                accent="#fb923c"
            />
            <StatTile
                testId="mood-stat-logged"
                icon={<CalendarCheck className="h-4 w-4" />}
                value={String(insights.loggedDays)}
                label="Total logged"
                accent="var(--primary)"
            />
        </div>
    );
}

interface StatTileProps {
    testId: string;
    icon: React.ReactNode;
    value: string;
    suffix?: string;
    label: string;
    accent: string;
}

function StatTile({ testId, icon, value, suffix, label, accent }: StatTileProps) {
    return (
        <Card variant="wow-static" data-testid={testId} className="rounded-2xl p-4 gap-0">
            <div className="mb-2 flex items-center gap-2">
                <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${accent}22`, color: accent }}
                >
                    {icon}
                </span>
                <span className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/60">
                    {label}
                </span>
            </div>
            <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-foreground">{value}</span>
                {suffix && <span className="text-lg">{suffix}</span>}
            </div>
        </Card>
    );
}
