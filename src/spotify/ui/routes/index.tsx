import { compact, hours, int, pct } from "@app/spotify/lib/format";
import { AreaSeries, BarSeries, ChartCard, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { ScoreRow } from "@app/spotify/ui/components/Sparkline";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@ui/components/card";
import { StatCard } from "@ui/custom/stat-card";
import { CalendarDays, Clock, LayoutDashboard, Music2, Users } from "lucide-react";

export const Route = createFileRoute("/")({ component: OverviewPage });

function OverviewPage() {
    const { params, windowLabel, activeProfile } = useFilters();
    const summary = useReport("summary", params);

    return (
        <>
            <PageHeader
                title="Overview"
                subtitle={`${activeProfile?.label ?? activeProfile?.name ?? "no profile"} · ${windowLabel}`}
                icon={<LayoutDashboard className="h-5 w-5" />}
            />

            <ReportState query={summary} isEmpty={(r) => r.empty} rows={8}>
                {(r) => (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                            <StatCard
                                value={int(r.totals.plays)}
                                label="plays"
                                trend={`+${int(r.totals.shortPlays)} under 30s`}
                                trendPositive={false}
                                icon={<Music2 className="h-4 w-4" />}
                            />
                            <StatCard
                                value={hours(r.totals.ms)}
                                label="listening time"
                                trend={`${(r.totals.ms / 86400000).toFixed(1)} full days`}
                                icon={<Clock className="h-4 w-4" />}
                            />
                            <StatCard
                                value={int(r.totals.artists)}
                                label="distinct artists"
                                trend={`${int(r.totals.tracks)} tracks · ${int(r.totals.albums)} albums`}
                                icon={<Users className="h-4 w-4" />}
                            />
                            <StatCard
                                value={int(r.totals.activeDays)}
                                label="active days"
                                trend={`${pct(r.shape.activeDayShare, 0)} of ${int(r.span.days)}`}
                                icon={<CalendarDays className="h-4 w-4" />}
                            />
                        </div>

                        <Section title="Shape of the listening">
                            <div className="grid md:grid-cols-2 gap-3">
                                <Card variant="wow-static" className="p-4 space-y-4">
                                    <ScoreRow
                                        label="diversity"
                                        value={r.shape.diversity}
                                        hint="1.0 = every artist played equally"
                                    />
                                    <ScoreRow
                                        label="concentration"
                                        value={r.shape.concentration}
                                        hint="Gini over artist plays"
                                    />
                                    {r.shape.likedShareOfPlays !== null && (
                                        <ScoreRow
                                            label="from the library"
                                            value={r.shape.likedShareOfPlays}
                                            hint={`${int(r.shape.likedTracks)} liked tracks`}
                                        />
                                    )}
                                </Card>
                                <Card variant="wow-static" className="p-4 space-y-3">
                                    <Row
                                        label="span"
                                        value={`${r.span.from.slice(0, 10)} → ${r.span.to.slice(0, 10)}`}
                                    />
                                    <Row
                                        label="sittings"
                                        value={`${int(r.totals.sessions)} · median ${Math.round(r.totals.medianSessionMinutes)} min`}
                                    />
                                    <Row label="plays per active day" value={r.shape.playsPerActiveDay.toFixed(1)} />
                                    <Row
                                        label="longest streak"
                                        value={
                                            r.streak
                                                ? `${r.streak.length} days · ${r.streak.start} → ${r.streak.end}`
                                                : "—"
                                        }
                                    />
                                </Card>
                            </div>
                        </Section>

                        <Section title="Monthly plays" hint="Every month between the first and last play on record.">
                            <ChartCard>
                                <AreaSeries
                                    data={r.monthly.map((m) => ({ label: m.month, value: m.plays }))}
                                    format={(v) => compact(v)}
                                />
                            </ChartCard>
                        </Section>

                        <Section title="By year">
                            <div className="grid lg:grid-cols-2 gap-3">
                                <ChartCard title="Plays per year">
                                    <BarSeries
                                        data={r.years.map((y) => ({ label: y.year, value: y.plays }))}
                                        format={(v) => compact(v)}
                                    />
                                </ChartCard>
                                <DataTable
                                    rows={r.years}
                                    rowKey={(y) => y.year}
                                    pageSize={14}
                                    columns={[
                                        { key: "year", header: "year", render: (y) => y.year },
                                        { key: "plays", header: "plays", align: "right", render: (y) => int(y.plays) },
                                        { key: "hours", header: "hours", align: "right", render: (y) => hours(y.ms) },
                                        {
                                            key: "artists",
                                            header: "artists",
                                            align: "right",
                                            render: (y) => int(y.artists),
                                        },
                                        {
                                            key: "new",
                                            header: "new",
                                            align: "right",
                                            render: (y) => <span className="text-primary">+{int(y.newArtists)}</span>,
                                        },
                                        {
                                            key: "top",
                                            header: "top artist",
                                            render: (y) => (
                                                <span className="truncate block max-w-40">{y.topArtist ?? "—"}</span>
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                        </Section>

                        {r.topGenres.length > 0 && (
                            <Section
                                title="Dominant genres"
                                hint="Genres come from MusicBrainz and Last.fm, never from Spotify. A play counts once per genre it carries."
                            >
                                <DataTable
                                    rows={r.topGenres}
                                    rowKey={(g) => g.genre}
                                    pageSize={10}
                                    searchable
                                    searchPlaceholder="Filter genres…"
                                    columns={[
                                        {
                                            key: "genre",
                                            header: "genre",
                                            render: (g) => g.genre,
                                            search: (g) => g.genre,
                                        },
                                        {
                                            key: "share",
                                            header: "share",
                                            align: "right",
                                            render: (g) => pct(g.share, 1),
                                        },
                                        { key: "plays", header: "plays", align: "right", render: (g) => int(g.plays) },
                                        {
                                            key: "bar",
                                            header: "",
                                            width: "34%",
                                            render: (g) => (
                                                <BarCell
                                                    value={g.plays}
                                                    max={r.topGenres[0]?.plays ?? 1}
                                                    color={SERIES[1]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            </Section>
                        )}
                    </>
                )}
            </ReportState>
        </>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
            <span className="text-sm text-foreground text-right">{value}</span>
        </div>
    );
}
