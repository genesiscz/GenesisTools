import { int, pct } from "@app/spotify/lib/format";
import { ChartCard, PairedBars, RadarSeries } from "@app/spotify/ui/components/charts";
import { DataTable } from "@app/spotify/ui/components/DataTable";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { ScoreBar } from "@app/spotify/ui/components/Sparkline";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Fingerprint } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/dna")({ component: DnaPage });

function DnaPage() {
    const { params, windowLabel } = useFilters();
    const dna = useReport("dna", params);

    const thisYear = new Date().getFullYear();
    const [from, setFrom] = useState(String(thisYear - 5));
    const [to, setTo] = useState(String(thisYear));
    const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
    const shift = useReport(
        "shift",
        { profile: params.profile, from: applied?.from, to: applied?.to },
        { enabled: !!applied }
    );

    return (
        <>
            <PageHeader title="Taste fingerprint" subtitle={windowLabel} icon={<Fingerprint className="h-5 w-5" />} />

            <Section title="Eight axes" hint="Each axis is a ratio in 0..1, so they fit on one screen together.">
                <ReportState query={dna} isEmpty={(r) => r.empty} rows={8}>
                    {(r) => (
                        <div className="grid lg:grid-cols-2 gap-3">
                            <ChartCard hint={`${int(r.plays)} plays`}>
                                <RadarSeries data={r.axes.map((a) => ({ axis: a.axis, value: a.value }))} />
                            </ChartCard>
                            <Card variant="wow-static" className="p-4 space-y-4">
                                {r.axes.map((a) => (
                                    <div key={a.axis}>
                                        <div className="flex items-baseline justify-between mb-1">
                                            <span className="text-sm font-medium text-foreground">{a.axis}</span>
                                            <span className="text-xs text-muted-foreground">{a.detail}</span>
                                        </div>
                                        <ScoreBar value={a.value} />
                                        <div className="text-[11px] text-muted-foreground mt-1">
                                            {a.low} ← → {a.high}
                                        </div>
                                    </div>
                                ))}
                            </Card>
                        </div>
                    )}
                </ReportState>
            </Section>

            <Section
                title="Compare yourself to your past self"
                hint="The same computation as comparing two people. A period is a year, or an explicit YYYY-MM-DD:YYYY-MM-DD range."
                actions={
                    <div className="flex items-center gap-2">
                        <Input
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-8 w-32 text-xs font-mono"
                            aria-label="From period"
                        />
                        <span className="text-muted-foreground text-xs">→</span>
                        <Input
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-8 w-32 text-xs font-mono"
                            aria-label="To period"
                        />
                        <Button size="sm" variant="brand" onClick={() => setApplied({ from, to })}>
                            Compare
                        </Button>
                    </div>
                }
            >
                {!applied ? (
                    <Card variant="wow-static" className="p-6 text-sm text-muted-foreground">
                        Pick two periods and press Compare.
                    </Card>
                ) : (
                    <ReportState query={shift} rows={6}>
                        {(r) => (
                            <>
                                <div className="grid md:grid-cols-2 gap-3 mb-4">
                                    <Card variant="wow-static" className="p-4">
                                        <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
                                            continuity
                                        </div>
                                        <ScoreBar value={r.continuity} />
                                        <div className="text-xs text-muted-foreground mt-2">
                                            how much of the old taste survived · change {pct(r.change, 1)}
                                        </div>
                                    </Card>
                                    <Card variant="wow-static" className="p-4 space-y-2">
                                        <PeriodRow label={r.from} plays={r.plays.from} artists={r.artists.from} />
                                        <PeriodRow label={r.to} plays={r.plays.to} artists={r.artists.to} />
                                    </Card>
                                </div>

                                <div className="grid lg:grid-cols-2 gap-3 mb-4">
                                    <Card variant="wow-static" className="p-4 space-y-3">
                                        <div className="text-sm font-medium text-foreground">What moved</div>
                                        {r.components.map((c) => (
                                            <div key={c.name}>
                                                <div className="flex items-baseline justify-between mb-1">
                                                    <span className="text-xs text-muted-foreground">{c.name}</span>
                                                    <span className="text-xs font-mono">weight {pct(c.weight, 0)}</span>
                                                </div>
                                                <ScoreBar value={c.score} />
                                            </div>
                                        ))}
                                    </Card>
                                    <ChartCard title="Genres that grew and shrank">
                                        <PairedBars
                                            data={r.genreShifts.slice(0, 12).map((g) => ({
                                                label: g.genre,
                                                a: g.from,
                                                b: g.to,
                                            }))}
                                            aLabel={r.from}
                                            bLabel={r.to}
                                            format={(v) => pct(v, 1)}
                                        />
                                    </ChartCard>
                                </div>

                                <div className="grid lg:grid-cols-2 gap-3">
                                    <DataTable
                                        rows={r.droppedArtists}
                                        rowKey={(a) => a.artist}
                                        pageSize={12}
                                        empty="Nothing dropped out."
                                        columns={[
                                            { key: "artist", header: `only in ${r.from}`, render: (a) => a.artist },
                                            {
                                                key: "plays",
                                                header: "plays",
                                                align: "right",
                                                render: (a) => int(a.plays),
                                            },
                                        ]}
                                    />
                                    <DataTable
                                        rows={r.gainedArtists}
                                        rowKey={(a) => a.artist}
                                        pageSize={12}
                                        empty="Nothing new arrived."
                                        columns={[
                                            { key: "artist", header: `only in ${r.to}`, render: (a) => a.artist },
                                            {
                                                key: "plays",
                                                header: "plays",
                                                align: "right",
                                                render: (a) => int(a.plays),
                                            },
                                        ]}
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground mt-2">
                                    "Only in one period" means present in one and absent from the other — not first-ever
                                    discoveries.
                                </p>
                            </>
                        )}
                    </ReportState>
                )}
            </Section>
        </>
    );
}

function PeriodRow({ label, plays, artists }: { label: string; plays: number; artists: number }) {
    return (
        <div className="flex items-baseline justify-between">
            <span className="text-sm font-mono text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">
                {int(plays)} plays · {int(artists)} artists
            </span>
        </div>
    );
}
