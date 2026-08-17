import { compact, hours, int, pct } from "@app/spotify/lib/format";
import type { TopKind, TopReport } from "@app/spotify/lib/reports/top";
import { BarSeries, ChartCard, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { Sparkline } from "@app/spotify/ui/components/Sparkline";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { Trophy } from "lucide-react";
import { useState } from "react";

const KINDS: { value: TopKind; label: string }[] = [
    { value: "tracks", label: "Tracks" },
    { value: "songs", label: "Songs" },
    { value: "artists", label: "Artists" },
    { value: "albums", label: "Albums" },
    { value: "genres", label: "Genres" },
];

export const Route = createFileRoute("/top")({ component: TopPage });

function TopPage() {
    const { params, windowLabel } = useFilters();
    const [kind, setKind] = useState<TopKind>("artists");
    const [metric, setMetric] = useState<"plays" | "hours">("plays");
    const top = useReport("top", { ...params, kind, by: metric, top: 60 });

    return (
        <>
            <PageHeader
                title="Rankings"
                subtitle={windowLabel}
                icon={<Trophy className="h-5 w-5" />}
                actions={
                    <ToggleGroup
                        type="single"
                        value={metric}
                        onValueChange={(v) => v && setMetric(v as "plays" | "hours")}
                        variant="outline"
                        size="sm"
                    >
                        <ToggleGroupItem value="plays" className="text-xs px-3">
                            plays
                        </ToggleGroupItem>
                        <ToggleGroupItem value="hours" className="text-xs px-3">
                            hours
                        </ToggleGroupItem>
                    </ToggleGroup>
                }
            />

            <Tabs value={kind} onValueChange={(v) => setKind(v as TopKind)} className="mb-5">
                <TabsList>
                    {KINDS.map((k) => (
                        <TabsTrigger key={k.value} value={k.value}>
                            {k.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>

            <ReportState
                query={top}
                isEmpty={(r) => (r.kind === "genres" ? !r.genresMissing && r.genres.length === 0 : r.rows.length === 0)}
                rows={10}
            >
                {(r) => (r.kind === "genres" ? <GenreView report={r} /> : <RankingView report={r} metric={metric} />)}
            </ReportState>
        </>
    );
}

function RankingView({ report: r, metric }: { report: TopReport; metric: "plays" | "hours" }) {
    // The rows are ordered by the SELECTED metric, so when that metric is hours the first row is
    // not the one with the most plays. Scale the fallback bar against the real maximum.
    const maxPlays = r.rows.reduce((max, row) => Math.max(max, row.plays), 0);

    return (
        <>
            <Section title="Top 20" hint="Ranked by the metric selected above.">
                <ChartCard>
                    <BarSeries
                        data={r.rows.slice(0, 20).map((row) => ({
                            label: row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name,
                            value: metric === "hours" ? row.hours : row.plays,
                        }))}
                        height={260}
                        format={(v) => (metric === "hours" ? `${v}h` : compact(v))}
                    />
                </ChartCard>
            </Section>

            <Section
                title="Full ranking"
                hint={`${int(r.totals.distinct)} distinct ${r.kind} · ${int(r.totals.plays)} plays · ${hours(r.totals.ms)}`}
            >
                <DataTable
                    rows={r.rows}
                    rowKey={(row) => row.key}
                    searchable
                    searchPlaceholder="Filter by title or artist…"
                    pageSize={25}
                    columns={[
                        {
                            key: "rank",
                            header: "#",
                            align: "right",
                            width: "3rem",
                            render: (_row, i) => <span className="text-muted-foreground font-mono">{i + 1}</span>,
                        },
                        {
                            key: "name",
                            header: r.kind === "artists" ? "artist" : r.kind === "albums" ? "album" : "track",
                            render: (row) => <span className="font-medium">{row.name}</span>,
                            search: (row) => row.name,
                        },
                        ...(r.kind === "artists"
                            ? []
                            : [
                                  {
                                      key: "artist",
                                      header: "artist",
                                      render: (row: (typeof r.rows)[number]) => (
                                          <span className="text-muted-foreground">{row.artist}</span>
                                      ),
                                      search: (row: (typeof r.rows)[number]) => row.artist,
                                  },
                              ]),
                        {
                            key: "plays",
                            header: "plays",
                            align: "right",
                            render: (row) => int(row.plays),
                        },
                        {
                            key: "hours",
                            header: "hours",
                            align: "right",
                            render: (row) => hours(row.ms),
                        },
                        {
                            key: "releases",
                            header: r.kind === "songs" ? "rel" : "tracks",
                            align: "right",
                            render: (row) => row.releases,
                        },
                        {
                            key: "trend",
                            header: "trend",
                            width: "7rem",
                            render: (row) =>
                                row.trend?.length ? (
                                    <Sparkline values={row.trend} />
                                ) : (
                                    <BarCell value={row.plays} max={maxPlays || 1} />
                                ),
                        },
                    ]}
                    footer={
                        r.trendBucket
                            ? `Trend sparklines are per ${r.trendBucket}, computed for the first ${r.limit} rows only.`
                            : undefined
                    }
                />
            </Section>
        </>
    );
}

function GenreView({ report }: { report: TopReport }) {
    if (report.genresMissing) {
        return (
            <Section title="No genre data for this profile">
                <p className="text-sm text-muted-foreground">
                    Genres come from MusicBrainz and Last.fm, not from Spotify. Run{" "}
                    <code className="font-mono text-primary">tools spotify enrich --profile {report.head.profile}</code>{" "}
                    to fetch them.
                </p>
            </Section>
        );
    }

    const total = report.coverage.taggedPlays + report.coverage.untaggedPlays;

    return (
        <>
            <Section title="Top genres">
                <ChartCard>
                    <BarSeries
                        data={report.genres.slice(0, 20).map((g) => ({ label: g.genre, value: g.plays }))}
                        height={260}
                        format={(v) => compact(v)}
                    />
                </ChartCard>
            </Section>

            <Section title="Every genre">
                <DataTable
                    rows={report.genres}
                    rowKey={(g) => g.genre}
                    searchable
                    searchPlaceholder="Filter genres…"
                    columns={[
                        {
                            key: "rank",
                            header: "#",
                            align: "right",
                            width: "3rem",
                            render: (_g, i) => <span className="text-muted-foreground font-mono">{i + 1}</span>,
                        },
                        { key: "genre", header: "genre", render: (g) => g.genre, search: (g) => g.genre },
                        { key: "plays", header: "plays", align: "right", render: (g) => int(g.plays) },
                        { key: "hours", header: "hours", align: "right", render: (g) => hours(g.ms) },
                        { key: "share", header: "share", align: "right", render: (g) => pct(g.share, 1) },
                        { key: "tracks", header: "tracks", align: "right", render: (g) => int(g.tracks) },
                        { key: "artists", header: "artists", align: "right", render: (g) => int(g.artists) },
                        {
                            key: "bar",
                            header: "",
                            width: "18%",
                            render: (g) => (
                                <BarCell value={g.plays} max={report.genres[0]?.plays ?? 1} color={SERIES[1]} />
                            ),
                        },
                    ]}
                    footer={
                        <span>
                            <Badge variant="cyber-secondary" className="mr-2">
                                coverage
                            </Badge>
                            {int(report.coverage.taggedPlays)} of {int(total)} plays carry a genre (
                            {pct(report.coverage.taggedPlays / Math.max(1, total), 0)}). A play counts once per genre it
                            has, so the shares add up to more than 100%.
                        </span>
                    }
                />
            </Section>
        </>
    );
}
