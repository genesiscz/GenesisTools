import { compact, int, pct } from "@app/spotify/lib/format";
import { AreaSeries, BarSeries, ChartCard, LineSeries, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section, StatTile } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Heart } from "lucide-react";

export const Route = createFileRoute("/library")({ component: LibraryPage });

function LibraryPage() {
    const { params, windowLabel } = useFilters();
    const audit = useReport("audit", params);
    const gems = useReport("gems", params);
    const mainstream = useReport("mainstream", params);
    const saves = useReport("saves", params);

    return (
        <>
            <PageHeader
                title="Saved versus played"
                subtitle={`${windowLabel} · personal plays joined to global stream counts`}
                icon={<Heart className="h-5 w-5" />}
            />

            <Card variant="wow-static" className="p-3 mb-6 text-xs text-muted-foreground">
                <span className="text-primary font-medium">plays</span> is always personal.{" "}
                <span className="text-primary font-medium">world</span> is the track's worldwide stream total, unrelated
                to how often you played it. Only the two reports on this page mix them, and both label each side.
            </Card>

            <Tabs defaultValue="audit">
                <TabsList className="mb-4">
                    <TabsTrigger value="audit">Audit</TabsTrigger>
                    <TabsTrigger value="gems">Hidden gems</TabsTrigger>
                    <TabsTrigger value="mainstream">Mainstream</TabsTrigger>
                    <TabsTrigger value="saves">Growth</TabsTrigger>
                </TabsList>

                <TabsContent value="audit">
                    <ReportState query={audit} rows={8}>
                        {(r) => (
                            <>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                                    <StatTile label="liked tracks" value={int(r.library)} />
                                    <StatTile
                                        label="never played"
                                        value={int(r.neverPlayed)}
                                        hint={pct(r.neverPlayed / Math.max(1, r.library), 0)}
                                    />
                                    <StatTile label="duplicate saves" value={int(r.duplicateSaves)} />
                                    <StatTile label="played, not liked" value={int(r.topUnliked.length)} />
                                </div>

                                <Section title="Played hard, never saved">
                                    <DataTable
                                        rows={r.topUnliked}
                                        rowKey={(t) => `${t.track}-${t.artist}`}
                                        searchable
                                        searchPlaceholder="Filter tracks…"
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
                                                render: (t) => (
                                                    <span className="text-muted-foreground">{t.artist}</span>
                                                ),
                                                search: (t) => t.artist,
                                            },
                                            {
                                                key: "plays",
                                                header: "plays",
                                                align: "right",
                                                render: (t) => int(t.plays),
                                            },
                                            {
                                                key: "bar",
                                                header: "",
                                                width: "26%",
                                                render: (t) => (
                                                    <BarCell value={t.plays} max={r.topUnliked[0]?.plays ?? 1} />
                                                ),
                                            },
                                        ]}
                                    />
                                </Section>

                                <Section title="Saved and never played">
                                    <DataTable
                                        rows={r.sampleNeverPlayed}
                                        rowKey={(t) => `${t.track}-${t.artist}-${t.addedAt ?? ""}`}
                                        searchable
                                        searchPlaceholder="Filter tracks…"
                                        empty="Every liked track has been played at least once."
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
                                                render: (t) => (
                                                    <span className="text-muted-foreground">{t.artist}</span>
                                                ),
                                                search: (t) => t.artist,
                                            },
                                            {
                                                key: "added",
                                                header: "added",
                                                render: (t) => (t.addedAt ?? "").slice(0, 10),
                                            },
                                        ]}
                                        footer={`${int(r.neverPlayedButOtherRelease)} more were played on a different release of the same song.`}
                                    />
                                </Section>

                                {r.duplicates.length > 0 && (
                                    <Section title="Saved more than once">
                                        <DataTable
                                            rows={r.duplicates}
                                            rowKey={(d) => d.song}
                                            pageSize={12}
                                            searchable
                                            searchPlaceholder="Filter songs…"
                                            columns={[
                                                {
                                                    key: "song",
                                                    header: "song",
                                                    render: (d) => d.song,
                                                    search: (d) => d.song,
                                                },
                                                {
                                                    key: "copies",
                                                    header: "copies",
                                                    align: "right",
                                                    render: (d) => d.copies,
                                                },
                                            ]}
                                        />
                                    </Section>
                                )}
                            </>
                        )}
                    </ReportState>
                </TabsContent>

                <TabsContent value="gems">
                    <ReportState query={gems} rows={8}>
                        {(r) => (
                            <DataTable
                                rows={r.gems}
                                rowKey={(g) => g.uri}
                                searchable
                                searchPlaceholder="Filter tracks…"
                                empty="No track clears both thresholds in this window."
                                columns={[
                                    { key: "track", header: "track", render: (g) => g.track, search: (g) => g.track },
                                    {
                                        key: "artist",
                                        header: "artist",
                                        render: (g) => <span className="text-muted-foreground">{g.artist}</span>,
                                        search: (g) => g.artist,
                                    },
                                    { key: "you", header: "you", align: "right", render: (g) => int(g.plays) },
                                    {
                                        key: "world",
                                        header: "world",
                                        align: "right",
                                        render: (g) => compact(g.playcount),
                                    },
                                    {
                                        key: "share",
                                        header: "your share",
                                        align: "right",
                                        render: (g) => pct(g.ratio, g.ratio >= 0.001 ? 3 : 4),
                                    },
                                ]}
                                footer={`At least ${r.minPlays} of your plays, under ${compact(r.maxGlobal)} global streams. "Your share" is your plays as a fraction of the track's entire worldwide stream count.`}
                            />
                        )}
                    </ReportState>
                </TabsContent>

                <TabsContent value="mainstream">
                    <ReportState
                        query={mainstream}
                        isEmpty={(r) => r.unjoinable}
                        emptyTitle="No plays overlap the harvested library"
                        emptyDescription="Global stream counts only exist for liked tracks, so there is nothing to join."
                        rows={8}
                    >
                        {(r) => (
                            <>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                                    <StatTile label="median track" value={`${compact(r.medianGlobal)} streams`} />
                                    <StatTile
                                        label="under 1M"
                                        value={pct(r.underOneMillionShare, 0)}
                                        hint="of your plays"
                                    />
                                    <StatTile
                                        label="over 100M"
                                        value={pct(r.overHundredMillionShare, 0)}
                                        hint="of your plays"
                                    />
                                    <StatTile
                                        label="agreement with the world"
                                        value={r.agreementWithWorld.toFixed(2)}
                                        hint="rank correlation; 0 = unrelated"
                                    />
                                </div>

                                <Section
                                    title="Median popularity by year"
                                    hint="Stream counts are TODAY's totals, so an old play of a song that later blew up is measured with its current number. Read the trend, not the level."
                                >
                                    <ChartCard>
                                        <LineSeries
                                            data={r.byYear.map((y) => ({ label: y.year, median: y.medianGlobal }))}
                                            series={[{ key: "median", label: "median global streams" }]}
                                            format={(v) => compact(v)}
                                        />
                                    </ChartCard>
                                </Section>

                                <Section title="Artists, most mainstream first">
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
                                                key: "plays",
                                                header: "your plays",
                                                align: "right",
                                                render: (a) => int(a.plays),
                                            },
                                            {
                                                key: "avg",
                                                header: "avg global",
                                                align: "right",
                                                render: (a) => compact(a.avgGlobal),
                                            },
                                            {
                                                key: "bar",
                                                header: "",
                                                width: "26%",
                                                render: (a) => (
                                                    <BarCell
                                                        value={a.avgGlobal}
                                                        max={r.artists[0]?.avgGlobal ?? 1}
                                                        color={SERIES[3]}
                                                    />
                                                ),
                                            },
                                        ]}
                                        footer={`Joined ${int(r.joinedPlays)} of ${int(r.ofPlays)} plays (${pct(r.joinedPlays / Math.max(1, r.ofPlays), 0)}); only liked tracks carry a global count. Artists need ${r.minPlays}+ plays to rank.`}
                                    />
                                </Section>
                            </>
                        )}
                    </ReportState>
                </TabsContent>

                <TabsContent value="saves">
                    <ReportState
                        query={saves}
                        isEmpty={(r) => r.empty}
                        emptyTitle="No harvested library for this profile"
                        emptyDescription="Run `tools spotify harvest`, then `tools spotify build`."
                        rows={5}
                    >
                        {(r) => (
                            <>
                                <div className="grid grid-cols-2 gap-3 mb-4">
                                    <StatTile label="liked tracks" value={int(r.total)} />
                                    <StatTile
                                        label="busiest month"
                                        value={r.busiest?.month ?? "—"}
                                        hint={r.busiest ? `${r.busiest.saved} saves` : undefined}
                                    />
                                </div>
                                <ChartCard title="Saves per month">
                                    <AreaSeries
                                        data={r.byMonth.map((m) => ({ label: m.month, value: m.saved }))}
                                        format={(v) => compact(v)}
                                    />
                                </ChartCard>
                                <div className="mt-3">
                                    <ChartCard title="Last two years">
                                        <BarSeries
                                            data={r.byMonth.slice(-24).map((m) => ({ label: m.month, value: m.saved }))}
                                            format={(v) => compact(v)}
                                        />
                                    </ChartCard>
                                </div>
                            </>
                        )}
                    </ReportState>
                </TabsContent>
            </Tabs>
        </>
    );
}
