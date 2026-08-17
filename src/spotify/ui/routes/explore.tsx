import { hours, int, pct } from "@app/spotify/lib/format";
import { AreaSeries, ChartCard, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { EmptyBlock, PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Search } from "lucide-react";
import { type FormEvent, useState } from "react";

type Mode = "search" | "artist" | "track";

export const Route = createFileRoute("/explore")({ component: ExplorePage });

function ExplorePage() {
    const { params, windowLabel } = useFilters();
    const [mode, setMode] = useState<Mode>("search");
    const [draft, setDraft] = useState("");
    const [query, setQuery] = useState("");

    const enabled = query.trim().length > 0;
    const search = useReport("search", { ...params, q: query }, { enabled: enabled && mode === "search" });
    const artist = useReport("artist", { ...params, q: query }, { enabled: enabled && mode === "artist" });
    const track = useReport("track", { ...params, q: query }, { enabled: enabled && mode === "track" });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        setQuery(draft.trim());
    };

    return (
        <>
            <PageHeader title="Explore" subtitle={windowLabel} icon={<Search className="h-5 w-5" />} />

            <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="mb-4">
                <TabsList>
                    <TabsTrigger value="search">Everything</TabsTrigger>
                    <TabsTrigger value="artist">One artist</TabsTrigger>
                    <TabsTrigger value="track">One song</TabsTrigger>
                </TabsList>
            </Tabs>

            <form onSubmit={submit} className="flex items-center gap-2 mb-6">
                <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={
                        mode === "artist" ? "Artist name" : mode === "track" ? "Song title" : "Title, artist or album"
                    }
                    placeholder={
                        mode === "artist"
                            ? "artist name…"
                            : mode === "track"
                              ? "song title…"
                              : "title, artist or album…"
                    }
                    className="h-9"
                />
                <Button type="submit" variant="brand" disabled={!draft.trim()}>
                    Search
                </Button>
            </form>

            {!enabled && (
                <EmptyBlock
                    title="Search everything you have ever played"
                    description="Titles, artists and albums are all matched, over the window selected in the header."
                />
            )}

            {enabled && mode === "search" && (
                <ReportState query={search} isEmpty={(r) => !r.found} emptyTitle={`No plays match "${query}"`} rows={8}>
                    {(r) => (
                        <>
                            <div className="text-xs text-muted-foreground mb-3 font-mono">
                                {int(r.plays)} plays · {int(r.songs.length)} songs · {int(r.artists.length)} artists
                            </div>
                            <div className="grid lg:grid-cols-3 gap-3">
                                <div className="lg:col-span-2">
                                    <DataTable
                                        rows={r.songs}
                                        rowKey={(s) => `${s.track}-${s.artist}`}
                                        searchable
                                        searchPlaceholder="Narrow these results…"
                                        columns={[
                                            {
                                                key: "track",
                                                header: "track",
                                                render: (s) => s.track,
                                                search: (s) => s.track,
                                            },
                                            {
                                                key: "artist",
                                                header: "artist",
                                                render: (s) => (
                                                    <span className="text-muted-foreground">{s.artist}</span>
                                                ),
                                                search: (s) => s.artist,
                                            },
                                            {
                                                key: "plays",
                                                header: "plays",
                                                align: "right",
                                                render: (s) => int(s.plays),
                                            },
                                            { key: "first", header: "first", render: (s) => s.first.slice(0, 10) },
                                            { key: "last", header: "last", render: (s) => s.last.slice(0, 10) },
                                        ]}
                                    />
                                </div>
                                <DataTable
                                    rows={r.artists}
                                    rowKey={(a) => a.artist}
                                    pageSize={15}
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
                                    ]}
                                />
                            </div>
                        </>
                    )}
                </ReportState>
            )}

            {enabled && mode === "artist" && (
                <ReportState
                    query={artist}
                    isEmpty={(r) => !r.found}
                    emptyTitle={`Nothing played by an artist matching "${query}"`}
                    rows={8}
                >
                    {(r) => (
                        <>
                            <Card variant="wow-static" className="p-5 mb-5">
                                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                                    <div className="text-2xl font-semibold text-foreground">{r.matched[0]}</div>
                                    <div className="text-xs font-mono text-muted-foreground">
                                        #{r.rank} of {int(r.totalArtists)} artists
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                    <Fact label="plays" value={int(r.plays)} />
                                    <Fact
                                        label="time"
                                        value={hours(r.ms)}
                                        hint={`${pct(r.shareOfPlays, 2)} of everything`}
                                    />
                                    <Fact label="first heard" value={r.first.slice(0, 10)} />
                                    <Fact label="last heard" value={r.last.slice(0, 10)} />
                                </div>
                                {r.genres.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-4">
                                        {r.genres.slice(0, 8).map((g) => (
                                            <Badge key={g} variant="cyber-secondary" className="text-[11px]">
                                                {g}
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                {r.matched.length > 1 && (
                                    <p className="text-xs text-muted-foreground mt-3">
                                        also matched: {r.matched.slice(1, 6).join(", ")}
                                    </p>
                                )}
                            </Card>

                            {r.arc && (
                                <Section title="The arc">
                                    <ChartCard
                                        hint={[
                                            `by ${r.arc.bucket}`,
                                            r.arc.peak && `peak ${r.arc.peak.bucket} with ${r.arc.peak.plays} plays`,
                                            r.peakWindow &&
                                                `${int(r.peakWindow.plays)} plays in the 30 days from ${r.peakWindow.start.slice(0, 10)}`,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    >
                                        <AreaSeries
                                            data={r.arc.fullKeys.map((k, i) => ({
                                                label: k,
                                                value: r.arc?.fullValues[i] ?? 0,
                                            }))}
                                        />
                                    </ChartCard>
                                </Section>
                            )}

                            <div className="grid lg:grid-cols-2 gap-3">
                                <DataTable
                                    rows={r.topTracks}
                                    rowKey={(t) => t.track}
                                    searchable
                                    searchPlaceholder="Filter tracks…"
                                    columns={[
                                        {
                                            key: "track",
                                            header: "top track",
                                            render: (t) => t.track,
                                            search: (t) => t.track,
                                        },
                                        { key: "plays", header: "plays", align: "right", render: (t) => int(t.plays) },
                                        { key: "hours", header: "hours", align: "right", render: (t) => hours(t.ms) },
                                        {
                                            key: "bar",
                                            header: "",
                                            width: "26%",
                                            render: (t) => <BarCell value={t.plays} max={r.topTracks[0]?.plays ?? 1} />,
                                        },
                                    ]}
                                />
                                <DataTable
                                    rows={r.topAlbums}
                                    rowKey={(a) => a.album}
                                    searchable
                                    searchPlaceholder="Filter albums…"
                                    columns={[
                                        {
                                            key: "album",
                                            header: "album",
                                            render: (a) => a.album,
                                            search: (a) => a.album,
                                        },
                                        { key: "plays", header: "plays", align: "right", render: (a) => int(a.plays) },
                                        { key: "tracks", header: "tracks", align: "right", render: (a) => a.tracks },
                                        {
                                            key: "bar",
                                            header: "",
                                            width: "26%",
                                            render: (a) => (
                                                <BarCell
                                                    value={a.plays}
                                                    max={r.topAlbums[0]?.plays ?? 1}
                                                    color={SERIES[1]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                        </>
                    )}
                </ReportState>
            )}

            {enabled && mode === "track" && (
                <ReportState
                    query={track}
                    isEmpty={(r) => !r.found}
                    emptyTitle={`Nothing played with a title matching "${query}"`}
                    rows={8}
                >
                    {(r) => (
                        <>
                            <Card variant="wow-static" className="p-5 mb-5">
                                <div className="text-2xl font-semibold text-foreground">{r.track}</div>
                                <div className="text-sm text-muted-foreground mb-4">{r.artist}</div>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                    <Fact
                                        label="plays"
                                        value={int(r.plays)}
                                        hint={`#${r.rank} of ${int(r.totalSongs)} songs`}
                                    />
                                    <Fact label="time" value={hours(r.ms)} hint={`+${r.shortPlays} under 30s`} />
                                    <Fact label="releases" value={String(r.releases)} hint="distinct track ids" />
                                    <Fact
                                        label="peak"
                                        value={`${int(r.peakWindow?.plays ?? 0)} plays`}
                                        hint={`30 days from ${(r.peakWindow?.start ?? "").slice(0, 10)}`}
                                    />
                                </div>
                            </Card>

                            {r.arc && (
                                <Section title="The arc">
                                    <ChartCard
                                        hint={`by ${r.arc.bucket} · ${r.first.slice(0, 10)} → ${r.last.slice(0, 10)}`}
                                    >
                                        <AreaSeries
                                            data={r.arc.fullKeys.map((k, i) => ({
                                                label: k,
                                                value: r.arc?.fullValues[i] ?? 0,
                                            }))}
                                        />
                                    </ChartCard>
                                </Section>
                            )}

                            {r.otherMatches.length > 0 && (
                                <Section title="Other titles that matched">
                                    <DataTable
                                        rows={r.otherMatches}
                                        rowKey={(o) => `${o.track}-${o.artist}`}
                                        searchable
                                        searchPlaceholder="Narrow these results…"
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
                                                key: "plays",
                                                header: "plays",
                                                align: "right",
                                                render: (o) => int(o.plays),
                                            },
                                        ]}
                                    />
                                </Section>
                            )}
                        </>
                    )}
                </ReportState>
            )}
        </>
    );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="text-base font-semibold text-foreground">{value}</div>
            {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
    );
}
