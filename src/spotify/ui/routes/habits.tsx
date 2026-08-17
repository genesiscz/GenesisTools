import { compact, hours, int, pct } from "@app/spotify/lib/format";
import { BarSeries, ChartCard, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section, StatTile } from "@app/spotify/ui/components/PageShell";
import { ScoreRow } from "@app/spotify/ui/components/Sparkline";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Activity } from "lucide-react";

export const Route = createFileRoute("/habits")({ component: HabitsPage });

function HabitsPage() {
    const { params, windowLabel } = useFilters();
    const behavior = useReport("behavior", params);
    const skips = useReport("skips", params);
    const sessions = useReport("sessions", params);
    const streaks = useReport("streaks", params);

    return (
        <>
            <PageHeader
                title="How the listening happens"
                subtitle={windowLabel}
                icon={<Activity className="h-5 w-5" />}
            />

            <Section title="Rates">
                <ReportState query={behavior} isEmpty={(r) => r.empty} rows={5}>
                    {(r) => (
                        <>
                            <Card variant="wow-static" className="p-4 space-y-4 mb-3">
                                <ScoreRow label="shuffle" value={r.rates.shuffle} hint="of plays" />
                                <ScoreRow label="offline" value={r.rates.offline} hint="of plays" />
                                <ScoreRow label="private" value={r.rates.incognito} hint="incognito sessions" />
                                <ScoreRow label="played to the end" value={r.rates.completed} hint="of events" />
                                <ScoreRow label="skipped forward" value={r.rates.forwardEnd} hint="of events" />
                            </Card>
                            <div className="grid lg:grid-cols-2 gap-3">
                                <Breakdown title="Devices" rows={r.platforms.slice(0, 12)} total={r.plays} />
                                <Breakdown title="Countries" rows={r.countries.slice(0, 8)} total={r.plays} />
                                <Breakdown
                                    title="How a track starts"
                                    rows={r.reasonStart.slice(0, 8)}
                                    total={r.events}
                                />
                                <Breakdown title="How a track ends" rows={r.reasonEnd.slice(0, 8)} total={r.events} />
                            </div>
                        </>
                    )}
                </ReportState>
            </Section>

            <Section
                title="Skips, sittings and streaks"
                hint="A skip is a start that ended under 30 seconds or on the forward button."
            >
                <Tabs defaultValue="skips">
                    <TabsList className="mb-3">
                        <TabsTrigger value="skips">Skips</TabsTrigger>
                        <TabsTrigger value="sessions">Sittings</TabsTrigger>
                        <TabsTrigger value="streaks">Streaks</TabsTrigger>
                    </TabsList>

                    <TabsContent value="skips">
                        <ReportState query={skips} rows={8}>
                            {(r) => (
                                <DataTable
                                    rows={r.artists}
                                    rowKey={(a) => a.artist}
                                    searchable
                                    searchPlaceholder="Filter artists…"
                                    columns={[
                                        {
                                            key: "artist",
                                            header: "artist",
                                            render: (a) => a.artist,
                                            search: (a) => a.artist,
                                        },
                                        {
                                            key: "starts",
                                            header: "starts",
                                            align: "right",
                                            render: (a) => int(a.starts),
                                        },
                                        { key: "skips", header: "skips", align: "right", render: (a) => int(a.skips) },
                                        { key: "rate", header: "rate", align: "right", render: (a) => pct(a.rate, 0) },
                                        {
                                            key: "bar",
                                            header: "",
                                            width: "30%",
                                            render: (a) => <BarCell value={a.rate} max={1} color={SERIES[4]} />,
                                        },
                                    ]}
                                    footer={`Overall skip rate ${pct(r.overallRate, 1)} · at least ${r.minStarts} starts to qualify.`}
                                />
                            )}
                        </ReportState>
                    </TabsContent>

                    <TabsContent value="sessions">
                        <ReportState query={sessions} isEmpty={(r) => r.empty} rows={8}>
                            {(r) => (
                                <>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                                        <StatTile label="sittings" value={int(r.count)} />
                                        <StatTile label="median length" value={`${r.medianMinutes.toFixed(0)} min`} />
                                        <StatTile label="mean length" value={`${r.meanMinutes.toFixed(0)} min`} />
                                        <StatTile label="per active day" value={r.perActiveDay.toFixed(1)} />
                                    </div>
                                    <DataTable
                                        rows={r.sessions}
                                        rowKey={(s) => s.start}
                                        columns={[
                                            {
                                                key: "start",
                                                header: "started",
                                                render: (s) => s.start.slice(0, 16).replace("T", " "),
                                            },
                                            {
                                                key: "minutes",
                                                header: "length",
                                                align: "right",
                                                render: (s) => `${Math.round(s.minutes)} min`,
                                            },
                                            {
                                                key: "tracks",
                                                header: "tracks",
                                                align: "right",
                                                render: (s) => s.tracks,
                                            },
                                            {
                                                key: "artists",
                                                header: "artists",
                                                align: "right",
                                                render: (s) => s.artists,
                                            },
                                            {
                                                key: "top",
                                                header: "mostly",
                                                render: (s) => (
                                                    <span className="text-muted-foreground">{s.topArtist}</span>
                                                ),
                                                search: (s) => s.topArtist,
                                            },
                                        ]}
                                        searchable
                                        searchPlaceholder="Filter by artist…"
                                        footer={`A gap over ${r.gapMinutes} minutes starts a new sitting.`}
                                    />
                                </>
                            )}
                        </ReportState>
                    </TabsContent>

                    <TabsContent value="streaks">
                        <ReportState query={streaks} isEmpty={(r) => r.empty} rows={8}>
                            {(r) => (
                                <>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                                        <StatTile label="active days" value={int(r.activeDays)} />
                                        <StatTile
                                            label="longest streak"
                                            value={r.longest ? `${r.longest.length} days` : "—"}
                                            hint={r.longest ? `${r.longest.start} → ${r.longest.end}` : undefined}
                                        />
                                        <StatTile
                                            label="latest streak"
                                            value={r.current ? `${r.current.length} days` : "—"}
                                            hint={r.current ? `ending ${r.current.end}` : undefined}
                                        />
                                    </div>
                                    <div className="grid lg:grid-cols-2 gap-3">
                                        <DataTable
                                            rows={r.runs}
                                            rowKey={(x) => `${x.start}-${x.end}`}
                                            pageSize={12}
                                            columns={[
                                                {
                                                    key: "days",
                                                    header: "days",
                                                    align: "right",
                                                    render: (x) => int(x.length),
                                                },
                                                { key: "from", header: "from", render: (x) => x.start },
                                                { key: "to", header: "to", render: (x) => x.end },
                                                {
                                                    key: "bar",
                                                    header: "",
                                                    width: "34%",
                                                    render: (x) => (
                                                        <BarCell
                                                            value={x.length}
                                                            max={r.runs[0]?.length ?? 1}
                                                            color={SERIES[2]}
                                                        />
                                                    ),
                                                },
                                            ]}
                                        />
                                        <DataTable
                                            rows={r.gaps}
                                            rowKey={(g) => `${g.from}-${g.to}`}
                                            pageSize={12}
                                            empty="No silences — every day on record has a play."
                                            columns={[
                                                {
                                                    key: "days",
                                                    header: "silent days",
                                                    align: "right",
                                                    render: (g) => int(g.days),
                                                },
                                                { key: "from", header: "after", render: (g) => g.from },
                                                { key: "to", header: "back on", render: (g) => g.to },
                                                {
                                                    key: "bar",
                                                    header: "",
                                                    width: "34%",
                                                    render: (g) => (
                                                        <BarCell
                                                            value={g.days}
                                                            max={r.gaps[0]?.days ?? 1}
                                                            color={SERIES[4]}
                                                        />
                                                    ),
                                                },
                                            ]}
                                        />
                                    </div>
                                </>
                            )}
                        </ReportState>
                    </TabsContent>
                </Tabs>
            </Section>
        </>
    );
}

function Breakdown({
    title,
    rows,
    total,
}: {
    title: string;
    rows: { key: string; plays: number; ms: number }[];
    total: number;
}) {
    if (!rows.length) {
        return null;
    }

    return (
        <ChartCard title={title}>
            <BarSeries
                data={rows.map((row) => ({ label: row.key, value: row.plays }))}
                height={180}
                format={(v) => compact(v)}
            />
            <div className="mt-2 space-y-1">
                {rows.slice(0, 5).map((row) => (
                    <div key={row.key} className="flex items-baseline justify-between text-xs">
                        <span className="text-muted-foreground">{row.key}</span>
                        <span className="font-mono tabular-nums">
                            {int(row.plays)} · {pct(row.plays / Math.max(1, total), 1)} · {hours(row.ms)}
                        </span>
                    </div>
                ))}
            </div>
        </ChartCard>
    );
}
