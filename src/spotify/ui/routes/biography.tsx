import { compact, int, pct } from "@app/spotify/lib/format";
import { BarSeries, ChartCard, LineSeries, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Sparkles } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/biography")({ component: BiographyPage });

type Tab = "firsts" | "obsessions" | "loyalty" | "forgotten";

function BiographyPage() {
    const { params, windowLabel } = useFilters();
    // Each of these is a full history scan, and only one tab is on screen. Fetch the visible
    // one; react-query keeps the others once they have been opened.
    const [tab, setTab] = useState<Tab>("firsts");
    const discovery = useReport("discovery", params);
    const firsts = useReport("firsts", params, { enabled: tab === "firsts" });
    const forgotten = useReport("forgotten", params, { enabled: tab === "forgotten" });
    const obsessions = useReport("obsessions", params, { enabled: tab === "obsessions" });
    const loyalty = useReport("loyalty", params, { enabled: tab === "loyalty" });

    return (
        <>
            <PageHeader
                title="What arrived when, and what stuck"
                subtitle={windowLabel}
                icon={<Sparkles className="h-5 w-5" />}
            />

            <Section
                title="Discovery"
                hint="Novelty is the share of a year's plays that went to an artist first heard that same year. The first year on record always reads 100%: nothing precedes it."
            >
                <ReportState query={discovery} isEmpty={(r) => r.empty} rows={5}>
                    {(r) => (
                        <div className="grid lg:grid-cols-2 gap-3">
                            <ChartCard title="New artists per year">
                                <BarSeries
                                    data={r.years.map((y) => ({ label: y.year, value: y.newArtists }))}
                                    format={(v) => compact(v)}
                                />
                            </ChartCard>
                            <ChartCard title="Novelty share">
                                <LineSeries
                                    data={r.years.map((y) => ({ label: y.year, novelty: y.noveltyShare }))}
                                    series={[{ key: "novelty", label: "novelty" }]}
                                    domain={[0, 1]}
                                    format={(v) => pct(v, 0)}
                                />
                            </ChartCard>
                            <div className="lg:col-span-2">
                                <DataTable
                                    rows={r.years}
                                    rowKey={(y) => y.year}
                                    pageSize={14}
                                    columns={[
                                        { key: "year", header: "year", render: (y) => y.year },
                                        { key: "plays", header: "plays", align: "right", render: (y) => int(y.plays) },
                                        {
                                            key: "artists",
                                            header: "artists",
                                            align: "right",
                                            render: (y) => int(y.artists),
                                        },
                                        {
                                            key: "newArtists",
                                            header: "new artists",
                                            align: "right",
                                            render: (y) => int(y.newArtists),
                                        },
                                        {
                                            key: "newTracks",
                                            header: "new tracks",
                                            align: "right",
                                            render: (y) => int(y.newTracks),
                                        },
                                        {
                                            key: "novelty",
                                            header: "novelty",
                                            align: "right",
                                            render: (y) => pct(y.noveltyShare, 0),
                                        },
                                    ]}
                                />
                            </div>
                        </div>
                    )}
                </ReportState>
            </Section>

            <Section title="The long arc">
                <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                    <TabsList className="mb-3">
                        <TabsTrigger value="firsts">First encounters</TabsTrigger>
                        <TabsTrigger value="obsessions">Obsessions</TabsTrigger>
                        <TabsTrigger value="loyalty">Loyalty</TabsTrigger>
                        <TabsTrigger value="forgotten">Forgotten</TabsTrigger>
                    </TabsList>

                    <TabsContent value="firsts">
                        <ReportState query={firsts} rows={8}>
                            {(r) => (
                                <DataTable
                                    rows={r.artists}
                                    rowKey={(a) => a.artist}
                                    searchable
                                    searchPlaceholder="Filter artists…"
                                    columns={[
                                        { key: "first", header: "first heard", render: (a) => a.first.slice(0, 10) },
                                        {
                                            key: "artist",
                                            header: "artist",
                                            render: (a) => a.artist,
                                            search: (a) => a.artist,
                                        },
                                        { key: "plays", header: "plays", align: "right", render: (a) => int(a.plays) },
                                        {
                                            key: "still",
                                            header: "still?",
                                            render: (a) =>
                                                a.stillActive ? (
                                                    <Badge variant="cyber">active</Badge>
                                                ) : (
                                                    <span className="text-muted-foreground font-mono text-xs">
                                                        {a.last.slice(0, 7)}
                                                    </span>
                                                ),
                                        },
                                        {
                                            key: "years",
                                            header: "years",
                                            align: "right",
                                            render: (a) => a.yearsActive.toFixed(1),
                                        },
                                    ]}
                                    footer={`Artists with at least ${r.minPlays} plays, oldest first.`}
                                />
                            )}
                        </ReportState>
                    </TabsContent>

                    <TabsContent value="obsessions">
                        <ReportState query={obsessions} isEmpty={(r) => r.empty} rows={8}>
                            {(r) => (
                                <>
                                    <DataTable
                                        rows={r.hardest}
                                        rowKey={(o) => `${o.track}-${o.artist}`}
                                        searchable
                                        searchPlaceholder="Filter tracks…"
                                        columns={[
                                            {
                                                key: "track",
                                                header: "track",
                                                render: (o) => o.track,
                                                search: (o) => o.track,
                                            },
                                            {
                                                key: "artist",
                                                header: "artist",
                                                render: (o) => (
                                                    <span className="text-muted-foreground">{o.artist}</span>
                                                ),
                                                search: (o) => o.artist,
                                            },
                                            {
                                                key: "peak",
                                                header: "peak",
                                                align: "right",
                                                render: (o) => int(o.peakPlays),
                                            },
                                            {
                                                key: "intensity",
                                                header: "of total",
                                                align: "right",
                                                render: (o) => pct(o.intensity, 0),
                                            },
                                            {
                                                key: "when",
                                                header: "when",
                                                render: (o) => o.windowStart.slice(0, 10),
                                            },
                                            {
                                                key: "bar",
                                                header: "",
                                                width: "20%",
                                                render: (o) => (
                                                    <BarCell
                                                        value={o.peakPlays}
                                                        max={r.hardest[0]?.peakPlays ?? 1}
                                                        color={SERIES[1]}
                                                    />
                                                ),
                                            },
                                        ]}
                                        footer={`Densest ${r.windowDays}-day window per song, for songs with at least ${r.minPlays} plays.`}
                                    />

                                    <div className="mt-3">
                                        <DataTable
                                            rows={[...r.byMonth].reverse()}
                                            rowKey={(o) => o.month}
                                            pageSize={12}
                                            columns={[
                                                { key: "month", header: "month", render: (o) => o.month },
                                                { key: "track", header: "song of the month", render: (o) => o.track },
                                                {
                                                    key: "artist",
                                                    header: "artist",
                                                    render: (o) => (
                                                        <span className="text-muted-foreground">{o.artist}</span>
                                                    ),
                                                },
                                                {
                                                    key: "peak",
                                                    header: "plays in window",
                                                    align: "right",
                                                    render: (o) => int(o.peakPlays),
                                                },
                                            ]}
                                        />
                                    </div>
                                </>
                            )}
                        </ReportState>
                    </TabsContent>

                    <TabsContent value="loyalty">
                        <ReportState query={loyalty} rows={8}>
                            {(r) => (
                                <DataTable
                                    rows={r.longestCompanions}
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
                                        { key: "plays", header: "plays", align: "right", render: (a) => int(a.plays) },
                                        {
                                            key: "months",
                                            header: "months",
                                            align: "right",
                                            render: (a) => int(a.activeMonths),
                                        },
                                        {
                                            key: "span",
                                            header: "span",
                                            align: "right",
                                            render: (a) => int(a.spanMonths),
                                        },
                                        {
                                            key: "consistency",
                                            header: "consistency",
                                            align: "right",
                                            render: (a) => pct(a.consistency, 0),
                                        },
                                        { key: "since", header: "since", render: (a) => a.first.slice(0, 7) },
                                        {
                                            key: "state",
                                            header: "",
                                            render: (a) =>
                                                a.stillActive ? (
                                                    <Badge variant="cyber">active</Badge>
                                                ) : (
                                                    <Badge variant="cyber-secondary">dormant</Badge>
                                                ),
                                        },
                                    ]}
                                    footer={`Months = distinct months with at least one play; consistency = months active ÷ months since the first play. Artists with ${r.minPlays}+ plays.`}
                                />
                            )}
                        </ReportState>
                    </TabsContent>

                    <TabsContent value="forgotten">
                        <ReportState query={forgotten} rows={8}>
                            {(r) => (
                                <DataTable
                                    rows={r.tracks}
                                    rowKey={(t) => `${t.track}-${t.artist}`}
                                    searchable
                                    searchPlaceholder="Filter tracks…"
                                    empty="Nothing has gone quiet for that long."
                                    columns={[
                                        {
                                            key: "track",
                                            header: "track",
                                            render: (t) => t.track,
                                            search: (t) => t.track,
                                        },
                                        {
                                            key: "artist",
                                            header: "artist",
                                            render: (t) => <span className="text-muted-foreground">{t.artist}</span>,
                                            search: (t) => t.artist,
                                        },
                                        { key: "plays", header: "plays", align: "right", render: (t) => int(t.plays) },
                                        {
                                            key: "last",
                                            header: "last played",
                                            render: (t) => t.lastPlayed.slice(0, 10),
                                        },
                                        {
                                            key: "silent",
                                            header: "silent",
                                            align: "right",
                                            render: (t) => `${t.silentMonths} mo`,
                                        },
                                    ]}
                                    footer={`Tracks with ${r.minPlays}+ plays that have been silent for ${r.quietMonths}+ months.`}
                                />
                            )}
                        </ReportState>
                    </TabsContent>
                </Tabs>
            </Section>
        </>
    );
}
