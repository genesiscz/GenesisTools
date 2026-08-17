import { compact, hours, int, pct } from "@app/spotify/lib/format";
import { BarSeries, ChartCard, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { StatCard } from "@ui/custom/stat-card";
import { Disc3 } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/wrapped")({ component: WrappedPage });

function WrappedPage() {
    const { params, activeProfile } = useFilters();
    const [year, setYear] = useState<string>("");
    // `wrapped` always spans a whole calendar year, so it deliberately ignores the header's
    // window; only the profile carries over.
    const wrapped = useReport("wrapped", { profile: params.profile, year: year || undefined });

    return (
        <>
            <PageHeader
                title="Wrapped"
                subtitle={`${activeProfile?.label ?? "profile"} · computed offline, for any year on record`}
                icon={<Disc3 className="h-5 w-5" />}
                actions={
                    <Select value={year || "__latest__"} onValueChange={(v) => setYear(v === "__latest__" ? "" : v)}>
                        <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="Year">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__latest__">latest</SelectItem>
                            {(wrapped.data?.yearsOnRecord ?? [])
                                .slice()
                                .reverse()
                                .map((y) => (
                                    <SelectItem key={y} value={String(y)}>
                                        {y}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                }
            />

            <ReportState query={wrapped} rows={8}>
                {(r) => (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                            <StatCard value={int(r.plays)} label={`plays in ${r.year}`} />
                            <StatCard
                                value={hours(r.ms)}
                                label="listening time"
                                trend={`${r.minutes.toLocaleString("en-US")} minutes`}
                            />
                            <StatCard
                                value={int(r.distinct.artists)}
                                label="artists"
                                trend={`${int(r.newArtists)} met this year`}
                            />
                            <StatCard
                                value={r.vsPreviousYear === null ? "—" : pct(r.vsPreviousYear, 0)}
                                label={`vs ${r.year - 1}`}
                                trendPositive={(r.vsPreviousYear ?? 0) >= 0}
                                trend={r.previous ? `${int(r.previous.plays)} plays then` : undefined}
                            />
                        </div>

                        <Section title="The year month by month">
                            <ChartCard>
                                <BarSeries
                                    data={r.byMonth.map((m) => ({ label: m.month, value: m.plays }))}
                                    format={(v) => compact(v)}
                                />
                            </ChartCard>
                        </Section>

                        <div className="grid lg:grid-cols-2 gap-3 mb-8">
                            <Card variant="wow-static" className="p-4 space-y-2">
                                <Row
                                    label="distinct"
                                    value={`${int(r.distinct.tracks)} tracks · ${int(r.distinct.albums)} albums`}
                                />
                                <Row
                                    label="active days"
                                    value={`${int(r.activeDays)} · ${(r.plays / Math.max(1, r.activeDays)).toFixed(1)} plays each`}
                                />
                                <Row label="sittings" value={int(r.sessions)} />
                                <Row
                                    label="carried over"
                                    value={`${int(r.carriedOver)} artists also played in ${r.year - 1}`}
                                />
                                <Row
                                    label="biggest day"
                                    value={r.topDay ? `${r.topDay.date} · ${r.topDay.plays} plays` : "—"}
                                />
                            </Card>
                            {r.topGenres.length > 0 && (
                                <Card variant="wow-static" className="p-4">
                                    <div className="text-sm font-medium text-foreground mb-3">Top genres</div>
                                    <div className="space-y-2">
                                        {r.topGenres.slice(0, 8).map((g) => (
                                            <div key={g.genre} className="flex items-center gap-3">
                                                <span className="text-xs w-32 truncate">{g.genre}</span>
                                                <div className="flex-1">
                                                    <BarCell
                                                        value={g.plays}
                                                        max={r.topGenres[0]?.plays ?? 1}
                                                        color={SERIES[3]}
                                                    />
                                                </div>
                                                <span className="text-xs font-mono tabular-nums w-12 text-right">
                                                    {pct(g.share, 1)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            )}
                        </div>

                        <div className="grid lg:grid-cols-2 gap-3">
                            <DataTable
                                rows={r.topSongs}
                                rowKey={(s) => `${s.track}-${s.artist}`}
                                pageSize={10}
                                searchable
                                searchPlaceholder="Filter songs…"
                                columns={[
                                    {
                                        key: "rank",
                                        header: "#",
                                        align: "right",
                                        width: "3rem",
                                        render: (_s, i) => (
                                            <span className="text-muted-foreground font-mono">{i + 1}</span>
                                        ),
                                    },
                                    {
                                        key: "track",
                                        header: "top song",
                                        render: (s) => s.track,
                                        search: (s) => s.track,
                                    },
                                    {
                                        key: "artist",
                                        header: "artist",
                                        render: (s) => <span className="text-muted-foreground">{s.artist}</span>,
                                        search: (s) => s.artist,
                                    },
                                    { key: "plays", header: "plays", align: "right", render: (s) => int(s.plays) },
                                ]}
                            />
                            <DataTable
                                rows={r.topArtists}
                                rowKey={(a) => a.artist}
                                pageSize={10}
                                searchable
                                searchPlaceholder="Filter artists…"
                                columns={[
                                    {
                                        key: "rank",
                                        header: "#",
                                        align: "right",
                                        width: "3rem",
                                        render: (_a, i) => (
                                            <span className="text-muted-foreground font-mono">{i + 1}</span>
                                        ),
                                    },
                                    {
                                        key: "artist",
                                        header: "top artist",
                                        render: (a) => a.artist,
                                        search: (a) => a.artist,
                                    },
                                    { key: "plays", header: "plays", align: "right", render: (a) => int(a.plays) },
                                    { key: "hours", header: "hours", align: "right", render: (a) => hours(a.ms) },
                                ]}
                            />
                        </div>

                        {r.discoveries.length > 0 && (
                            <Section title="Best discoveries" hint="Artists met for the first time this year.">
                                <div className="flex flex-wrap gap-2">
                                    {r.discoveries.map((d) => (
                                        <Badge key={d.artist} variant="cyber" className="text-xs">
                                            {d.artist} · {int(d.plays)}
                                        </Badge>
                                    ))}
                                </div>
                            </Section>
                        )}
                    </>
                )}
            </ReportState>
        </>
    );
}

function Row({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
            <span className="text-sm text-foreground text-right">{value}</span>
        </div>
    );
}
