import { compact, hours, int, pct } from "@app/spotify/lib/format";
import { AreaSeries, BarSeries, ChartCard } from "@app/spotify/ui/components/charts";
import { ClockGrid, YearGrid } from "@app/spotify/ui/components/HeatGrid";
import { PageHeader, ReportState, Section, StatTile } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { CalendarClock } from "lucide-react";
import { useState } from "react";

const BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
const AUTO = "__auto__";

export const Route = createFileRoute("/time")({ component: TimePage });

function TimePage() {
    const { params, windowLabel, activeProfile } = useFilters();
    const [bucket, setBucket] = useState<string>(AUTO);
    const [metric, setMetric] = useState<"plays" | "hours">("plays");

    const timeline = useReport("timeline", {
        ...params,
        bucket: bucket === AUTO ? undefined : bucket,
        by: metric,
    });
    const clock = useReport("clock", params);
    const calendar = useReport("calendar", params);
    const seasons = useReport("seasons", params);

    return (
        <>
            <PageHeader
                title="When the listening happens"
                subtitle={`${windowLabel} · ${activeProfile?.timezone ?? "local time"}`}
                icon={<CalendarClock className="h-5 w-5" />}
                actions={
                    <div className="flex items-center gap-2">
                        <Select value={metric} onValueChange={(v) => setMetric(v as "plays" | "hours")}>
                            <SelectTrigger className="h-8 w-[110px] text-xs" aria-label="Metric">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="plays">plays</SelectItem>
                                <SelectItem value="hours">hours</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={bucket} onValueChange={setBucket}>
                            <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="Bucket">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={AUTO}>auto</SelectItem>
                                {BUCKETS.map((b) => (
                                    <SelectItem key={b} value={b}>
                                        {b}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                }
            />

            <Section title="Timeline">
                <ReportState query={timeline} isEmpty={(r) => r.empty} rows={4}>
                    {(r) => (
                        <ChartCard
                            hint={[
                                `by ${r.bucket}`,
                                r.peak &&
                                    `peak ${r.peak.bucket} with ${
                                        r.metric === "ms" ? hours(r.peak.value) : `${int(r.peak.value)} plays`
                                    }`,
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        >
                            <AreaSeries
                                height={260}
                                data={r.points.map((p) => ({
                                    label: p.bucket,
                                    value: r.metric === "ms" ? +(p.ms / 3600000).toFixed(1) : p.plays,
                                }))}
                                format={(v) => (r.metric === "ms" ? `${v}h` : compact(v))}
                            />
                        </ChartCard>
                    )}
                </ReportState>
            </Section>

            <Section title="The weekly clock" hint="One cell per weekday-hour, in the profile's timezone.">
                <ReportState query={clock} isEmpty={(r) => r.empty} rows={7}>
                    {(r) => (
                        <>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                                <StatTile
                                    label="peak hour"
                                    value={`${String(r.peakHour).padStart(2, "0")}:00`}
                                    hint={`${int(r.byHour[r.peakHour] ?? 0)} plays`}
                                />
                                <StatTile label="night owl" value={pct(r.nightShare, 1)} hint="00:00 → 05:00" />
                                <StatTile label="office hours" value={pct(r.officeShare, 1)} hint="09:00 → 18:00" />
                                <StatTile label="weekend" value={pct(r.weekendShare, 1)} hint="Sat + Sun" />
                            </div>
                            <Card variant="wow-static" className="p-4">
                                <ClockGrid grid={r.byWeekdayHour} byWeekday={r.byWeekday} />
                            </Card>
                            <div className="mt-3">
                                <ChartCard title="Hour of day">
                                    <BarSeries
                                        height={180}
                                        data={r.byHour.map((v, h) => ({
                                            label: String(h).padStart(2, "0"),
                                            value: v,
                                        }))}
                                        highlightIndex={r.peakHour}
                                        format={(v) => compact(v)}
                                    />
                                </ChartCard>
                            </div>
                        </>
                    )}
                </ReportState>
            </Section>

            <Section title="Every day on record">
                <ReportState query={calendar} isEmpty={(r) => r.empty} rows={7}>
                    {(r) => (
                        <Card variant="wow-static" className="p-4">
                            {r.years.map((y) => (
                                <YearGrid key={y} year={y} days={r.days} max={r.max} />
                            ))}
                            <div className="text-xs text-muted-foreground">
                                Darkest cell = {int(r.max)} plays in one day.
                            </div>
                        </Card>
                    )}
                </ReportState>
            </Section>

            <Section title="Seasonal rhythm" hint="Every year stacked, so a habit shows up as a repeated shape.">
                <ReportState query={seasons} isEmpty={(r) => r.empty} rows={5}>
                    {(r) => (
                        <div className="grid lg:grid-cols-2 gap-3">
                            <ChartCard title="Month of year">
                                <BarSeries
                                    data={r.byMonth.map((m) => ({ label: m.month, value: m.plays }))}
                                    format={(v) => compact(v)}
                                />
                            </ChartCard>
                            <Card variant="wow-static" className="p-4 space-y-3">
                                {r.bySeason.map((s) => (
                                    <div key={s.season}>
                                        <div className="flex items-baseline justify-between">
                                            <span className="text-sm font-medium capitalize text-foreground">
                                                {s.season}
                                            </span>
                                            <span className="text-xs font-mono text-muted-foreground">
                                                {int(s.plays)} plays
                                            </span>
                                        </div>
                                        <div className="text-xs text-muted-foreground mt-0.5">
                                            {s.topGenres.length
                                                ? s.topGenres.map((g) => `${g.genre} ${pct(g.share, 0)}`).join(" · ")
                                                : "no genre data"}
                                        </div>
                                    </div>
                                ))}
                            </Card>
                        </div>
                    )}
                </ReportState>
            </Section>
        </>
    );
}
