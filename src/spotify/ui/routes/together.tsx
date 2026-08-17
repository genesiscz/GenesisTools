import { hours, int, pct } from "@app/spotify/lib/format";
import { ChartCard, LineSeries, PairedBars, SERIES } from "@app/spotify/ui/components/charts";
import { BarCell, DataTable } from "@app/spotify/ui/components/DataTable";
import { EmptyBlock, PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { ScoreBar } from "@app/spotify/ui/components/Sparkline";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { Gift } from "lucide-react";
import { useState } from "react";

const BUCKETS = ["month", "quarter", "year"] as const;

export const Route = createFileRoute("/together")({ component: TogetherPage });

function TogetherPage() {
    const { params, windowLabel, filters, setFilters, profiles, activeProfile } = useFilters();
    const rows = profiles.data?.profiles ?? [];
    const a = activeProfile?.name ?? "";
    // A stored partner that has since become the ACTIVE profile is treated as unset. Left
    // alone it made b === a, so `ready` went false and the page showed "add a second profile"
    // to someone who has several, with the Select stuck on a value its own option list
    // excludes. The only way out was re-picking a partner, which is not discoverable.
    const partner = filters.partner && filters.partner !== a ? filters.partner : "";
    const b = partner || rows.find((p) => p.name !== a)?.name || "";
    const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>("quarter");

    const ready = !!a && !!b && a !== b;
    const shared = { ...params, a, b };
    const compat = useReport("compat", shared, { enabled: ready });
    const timeline = useReport("compatTimeline", { ...shared, bucket }, { enabled: ready });
    const blend = useReport("blend", shared, { enabled: ready });
    const gift = useReport("gift", shared, { enabled: ready });

    return (
        <>
            <PageHeader
                title="Two people"
                subtitle={windowLabel}
                icon={<Gift className="h-5 w-5" />}
                actions={
                    <Select
                        value={b}
                        onValueChange={(name) => setFilters({ partner: name })}
                        disabled={rows.length < 2}
                    >
                        <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Compare with">
                            <SelectValue placeholder="compare with…" />
                        </SelectTrigger>
                        <SelectContent>
                            {rows
                                .filter((p) => p.name !== a)
                                .map((p) => (
                                    <SelectItem key={p.name} value={p.name}>
                                        {p.label || p.name}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                }
            />

            {!ready ? (
                <EmptyBlock
                    title="Add a second profile to compare"
                    description="A partner needs only their streaming-history export — no harvest, no login. Add it on the Settings page."
                />
            ) : (
                <>
                    <ReportState
                        query={compat}
                        isEmpty={(r) => !!r.emptySide}
                        emptyTitle="One side has no plays in this window"
                        emptyDescription="Widen the date range in the header."
                        rows={6}
                    >
                        {(r) => (
                            <>
                                <Card variant="wow-static" className="p-5 mb-6">
                                    <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
                                        {r.a.label} × {r.b.label}
                                    </div>
                                    <div className="text-4xl font-bold text-foreground mb-3">
                                        {pct(r.compatibility, 1)}
                                    </div>
                                    <ScoreBar value={r.compatibility} showValue={false} />
                                    <p className="text-sm text-muted-foreground mt-3">{r.verdict}</p>
                                </Card>

                                <Section
                                    title="What the score is made of"
                                    hint="One number hides which kind of agreement is happening. Two people can share almost no exact recordings and still live in the same three genres."
                                >
                                    <Card variant="wow-static" className="p-4 space-y-4">
                                        {r.components.map((c) => (
                                            <div key={c.name}>
                                                <div className="flex items-baseline justify-between mb-1">
                                                    <span className="text-sm text-foreground">{c.name}</span>
                                                    <span className="text-xs text-muted-foreground">
                                                        weight {pct(c.weight, 0)} · {c.detail}
                                                    </span>
                                                </div>
                                                <ScoreBar value={c.score} />
                                            </div>
                                        ))}
                                    </Card>
                                </Section>

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                                    <Side label={r.a.label} plays={r.a.plays} ms={r.a.ms} artists={r.a.artists} />
                                    <Side label={r.b.label} plays={r.b.plays} ms={r.b.ms} artists={r.b.artists} />
                                    <Card variant="wow-static" className="p-3">
                                        <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
                                            shared artists
                                        </div>
                                        <div className="text-lg font-semibold">{int(r.sharedArtists)}</div>
                                    </Card>
                                    <Card variant="wow-static" className="p-3">
                                        <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
                                            shared songs
                                        </div>
                                        <div className="text-lg font-semibold">{int(r.sharedSongs)}</div>
                                    </Card>
                                </div>

                                <Section
                                    title="Compatibility over time"
                                    hint="Periods too thin on either side stay unscored, rather than reporting missing data as divergence."
                                >
                                    <ReportState query={timeline} rows={5}>
                                        {(t) => (
                                            <ChartCard
                                                hint={
                                                    t.average !== null
                                                        ? `average ${pct(t.average, 1)} across ${t.points.filter((p) => p.compatibility !== null).length} ${t.bucket}s · closest ${t.closest?.bucket} · furthest ${t.furthest?.bucket}`
                                                        : `no ${t.bucket} has ${t.minPlays}+ plays on both sides`
                                                }
                                                actions={
                                                    <ToggleGroup
                                                        type="single"
                                                        value={bucket}
                                                        onValueChange={(v) =>
                                                            v && setBucket(v as (typeof BUCKETS)[number])
                                                        }
                                                        variant="outline"
                                                        size="sm"
                                                    >
                                                        {BUCKETS.map((x) => (
                                                            <ToggleGroupItem key={x} value={x} className="text-xs px-2">
                                                                {x}
                                                            </ToggleGroupItem>
                                                        ))}
                                                    </ToggleGroup>
                                                }
                                            >
                                                <LineSeries
                                                    data={t.points.map((p) => ({
                                                        label: p.bucket,
                                                        compatibility: p.compatibility,
                                                    }))}
                                                    series={[{ key: "compatibility", label: "compatibility" }]}
                                                    domain={[0, 1]}
                                                    format={(v) => pct(v, 0)}
                                                />
                                            </ChartCard>
                                        )}
                                    </ReportState>
                                </Section>

                                <Section title="Genre profiles side by side">
                                    <ChartCard>
                                        <PairedBars
                                            data={r.genreProfile.slice(0, 14).map((g) => ({
                                                label: g.genre,
                                                a: g.a,
                                                b: g.b,
                                            }))}
                                            aLabel={r.a.label}
                                            bLabel={r.b.label}
                                            format={(v) => pct(v, 1)}
                                            height={360}
                                        />
                                    </ChartCard>
                                </Section>

                                <Section title="Common ground and private territory">
                                    <Tabs defaultValue="shared">
                                        <TabsList className="mb-3">
                                            <TabsTrigger value="shared">Shared artists</TabsTrigger>
                                            <TabsTrigger value="songs">Shared songs</TabsTrigger>
                                            <TabsTrigger value="only">Private territory</TabsTrigger>
                                        </TabsList>

                                        <TabsContent value="shared">
                                            <DataTable
                                                rows={r.topShared}
                                                rowKey={(x) => x.artist}
                                                searchable
                                                searchPlaceholder="Filter artists…"
                                                columns={[
                                                    {
                                                        key: "artist",
                                                        header: "artist",
                                                        render: (x) => x.artist,
                                                        search: (x) => x.artist,
                                                    },
                                                    {
                                                        key: "a",
                                                        header: r.a.label,
                                                        align: "right",
                                                        render: (x) => pct(x.aShare, 2),
                                                    },
                                                    {
                                                        key: "b",
                                                        header: r.b.label,
                                                        align: "right",
                                                        render: (x) => pct(x.bShare, 2),
                                                    },
                                                    {
                                                        key: "bar",
                                                        header: "",
                                                        width: "30%",
                                                        render: (x) => (
                                                            <div className="flex gap-1">
                                                                <BarCell
                                                                    value={x.aShare}
                                                                    max={Math.max(x.aShare, x.bShare)}
                                                                    color={SERIES[0]}
                                                                />
                                                                <BarCell
                                                                    value={x.bShare}
                                                                    max={Math.max(x.aShare, x.bShare)}
                                                                    color={SERIES[1]}
                                                                />
                                                            </div>
                                                        ),
                                                    },
                                                ]}
                                            />
                                        </TabsContent>

                                        <TabsContent value="songs">
                                            <DataTable
                                                rows={r.sharedSongRows}
                                                rowKey={(x) => x.song}
                                                searchable
                                                searchPlaceholder="Filter songs…"
                                                empty="No song appears in both histories."
                                                columns={[
                                                    {
                                                        key: "song",
                                                        header: "song",
                                                        render: (x) => x.song,
                                                        search: (x) => x.song,
                                                    },
                                                    {
                                                        key: "a",
                                                        header: r.a.label,
                                                        align: "right",
                                                        render: (x) => pct(x.aShare, 3),
                                                    },
                                                    {
                                                        key: "b",
                                                        header: r.b.label,
                                                        align: "right",
                                                        render: (x) => pct(x.bShare, 3),
                                                    },
                                                ]}
                                            />
                                        </TabsContent>

                                        <TabsContent value="only">
                                            <div className="grid lg:grid-cols-2 gap-3">
                                                <DataTable
                                                    rows={r.onlyA}
                                                    rowKey={(x) => x.artist}
                                                    pageSize={12}
                                                    searchable
                                                    searchPlaceholder="Filter artists…"
                                                    columns={[
                                                        {
                                                            key: "artist",
                                                            header: `only ${r.a.label}`,
                                                            render: (x) => x.artist,
                                                            search: (x) => x.artist,
                                                        },
                                                        {
                                                            key: "share",
                                                            header: "share",
                                                            align: "right",
                                                            render: (x) => pct(x.share, 2),
                                                        },
                                                    ]}
                                                />
                                                <DataTable
                                                    rows={r.onlyB}
                                                    rowKey={(x) => x.artist}
                                                    pageSize={12}
                                                    searchable
                                                    searchPlaceholder="Filter artists…"
                                                    columns={[
                                                        {
                                                            key: "artist",
                                                            header: `only ${r.b.label}`,
                                                            render: (x) => x.artist,
                                                            search: (x) => x.artist,
                                                        },
                                                        {
                                                            key: "share",
                                                            header: "share",
                                                            align: "right",
                                                            render: (x) => pct(x.share, 2),
                                                        },
                                                    ]}
                                                />
                                            </div>
                                        </TabsContent>
                                    </Tabs>
                                </Section>
                            </>
                        )}
                    </ReportState>

                    <Section
                        title="Blend"
                        hint="Songs both of you actually play, ranked by the harmonic mean of each side's play share, so one-sided hits sink."
                    >
                        <ReportState query={blend} rows={6}>
                            {(r) => (
                                <DataTable
                                    rows={r.tracks}
                                    rowKey={(t) => t.song}
                                    searchable
                                    searchPlaceholder="Filter songs…"
                                    empty="Nothing overlaps at this threshold."
                                    columns={[
                                        {
                                            key: "rank",
                                            header: "#",
                                            align: "right",
                                            width: "3rem",
                                            render: (_t, i) => (
                                                <span className="text-muted-foreground font-mono">{i + 1}</span>
                                            ),
                                        },
                                        { key: "song", header: "song", render: (t) => t.song, search: (t) => t.song },
                                        {
                                            key: "a",
                                            header: r.a.label,
                                            align: "right",
                                            render: (t) => int(t.aPlays),
                                        },
                                        {
                                            key: "b",
                                            header: r.b.label,
                                            align: "right",
                                            render: (t) => int(t.bPlays),
                                        },
                                        {
                                            key: "match",
                                            header: "match",
                                            width: "22%",
                                            render: (t) => (
                                                <BarCell
                                                    value={t.score}
                                                    max={r.tracks[0]?.score ?? 1}
                                                    color={SERIES[2]}
                                                />
                                            ),
                                        },
                                    ]}
                                    footer={`Each side needs at least ${r.minPlays} plays of a song.`}
                                />
                            )}
                        </ReportState>
                    </Section>

                    <Section
                        title="Gift"
                        hint="Tracks the first profile plays that the second has never played once, weighted by how much they already like the artist and the genre."
                    >
                        <ReportState query={gift} rows={6}>
                            {(r) => (
                                <DataTable
                                    rows={r.candidates}
                                    rowKey={(c) => `${c.track}-${c.artist}`}
                                    searchable
                                    searchPlaceholder="Filter tracks…"
                                    empty="They have already heard everything."
                                    columns={[
                                        {
                                            key: "rank",
                                            header: "#",
                                            align: "right",
                                            width: "3rem",
                                            render: (_c, i) => (
                                                <span className="text-muted-foreground font-mono">{i + 1}</span>
                                            ),
                                        },
                                        {
                                            key: "track",
                                            header: "track",
                                            render: (c) => c.track,
                                            search: (c) => c.track,
                                        },
                                        {
                                            key: "artist",
                                            header: "artist",
                                            render: (c) => <span className="text-muted-foreground">{c.artist}</span>,
                                            search: (c) => c.artist,
                                        },
                                        {
                                            key: "yours",
                                            header: `${r.from.label} plays`,
                                            align: "right",
                                            render: (c) => int(c.yourPlays),
                                        },
                                        {
                                            key: "artistFit",
                                            header: "artist fit",
                                            align: "right",
                                            render: (c) => pct(c.theirArtistAffinity, 0),
                                        },
                                        {
                                            key: "genreFit",
                                            header: "genre fit",
                                            align: "right",
                                            render: (c) => pct(c.theirGenreAffinity, 0),
                                        },
                                        {
                                            key: "score",
                                            header: "",
                                            width: "18%",
                                            render: (c) => (
                                                <BarCell
                                                    value={c.score}
                                                    max={r.candidates[0]?.score ?? 1}
                                                    color={SERIES[2]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            )}
                        </ReportState>
                    </Section>
                </>
            )}
        </>
    );
}

function Side({ label, plays, ms, artists }: { label: string; plays: number; ms: number; artists: number }) {
    return (
        <Card variant="wow-static" className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold">{int(plays)}</div>
            <div className="text-xs text-muted-foreground">
                {hours(ms)} · {int(artists)} artists
            </div>
        </Card>
    );
}
