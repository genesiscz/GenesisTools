import { compact, int } from "@app/spotify/lib/format";
import type { Recommendation, RecommendMethod } from "@app/spotify/lib/reports/recommend";
import { EmptyBlock, PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { useReport } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Compass, Disc3, ExternalLink } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/discover")({ component: DiscoverPage });

/** Labels for the picker; the descriptions come from the report so CLI and UI say the same thing. */
const METHOD_TABS: { id: RecommendMethod; label: string }[] = [
    { id: "bursts", label: "Discovery bursts" },
    { id: "unfinished", label: "Unfinished artists" },
    { id: "old-loves", label: "Old loves" },
    { id: "neighbours", label: "Session neighbours" },
];

function spotifyUrl(uri: string | null, kind: "artist" | "album" | "track"): string | null {
    const prefix = `spotify:${kind}:`;

    return uri?.startsWith(prefix) ? `https://open.spotify.com/${kind}/${uri.slice(prefix.length)}` : null;
}

function DiscoverPage() {
    const { params, activeProfile } = useFilters();
    const [method, setMethod] = useState<RecommendMethod>("bursts");
    const report = useReport("recommend", { ...params, method, top: 24 });
    // Never show the previous method's picks under the newly selected tab while it loads.
    const current =
        report.data && report.data.method.id !== method ? { ...report, data: undefined, isPending: true } : report;

    return (
        <>
            <PageHeader
                title="Discover"
                subtitle={`${activeProfile?.label ?? activeProfile?.name ?? "no profile"} · from your whole history`}
                icon={<Compass className="h-5 w-5" />}
            />

            <Tabs value={method} onValueChange={(v) => setMethod(METHOD_TABS.find((m) => m.id === v)?.id ?? "bursts")}>
                <TabsList className="mb-4 flex-wrap h-auto">
                    {METHOD_TABS.map((m) => (
                        <TabsTrigger key={m.id} value={m.id}>
                            {m.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>

            <ReportState
                query={current}
                rows={6}
                isEmpty={(r) => !r.missingLibrary && r.recommendations.length === 0}
                emptyTitle="Nothing matched this method"
                emptyDescription="Try another method, or another profile."
            >
                {(r) => (
                    <>
                        <Card className="p-5 mb-6 gap-3">
                            <div className="text-sm font-semibold text-foreground">{r.method.title}</div>
                            <p className="text-sm text-muted-foreground max-w-3xl">{r.method.description}</p>
                            {r.settings.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {r.settings.map((s) => (
                                        <Badge key={s.label} variant="outline" className="font-normal">
                                            <span className="text-muted-foreground">{s.label}:</span> {s.value}
                                        </Badge>
                                    ))}
                                </div>
                            )}
                        </Card>

                        {!r.missingLibrary && r.catalog.covered < r.recommendations.length && (
                            <Card className="p-4 mb-6 gap-1">
                                <div className="text-sm font-medium text-foreground">
                                    Songs to try come from each artist's own Spotify page
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {r.catalog.covered} of {r.recommendations.length} picks have it. Fetch the rest from
                                    your signed-in browser: tools spotify harvest --artists --auto
                                </p>
                            </Card>
                        )}

                        {r.missingLibrary ? (
                            <EmptyBlock
                                title="This method needs your Liked Songs"
                                description="This profile has no harvested library yet. Run: tools spotify harvest --auto"
                            />
                        ) : (
                            <Section
                                title={`${r.recommendations.length} picks`}
                                hint="Each pick shows why it was chosen and the songs that triggered it. Artist and album names open in Spotify."
                            >
                                <div className="grid md:grid-cols-2 gap-4">
                                    {r.recommendations.map((rec, i) => (
                                        <RecommendationCard
                                            key={rec.artist}
                                            rec={rec}
                                            rank={i + 1}
                                            featured={i === 0}
                                        />
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

function RecommendationCard({ rec, rank, featured }: { rec: Recommendation; rank: number; featured: boolean }) {
    const artistUrl = spotifyUrl(rec.artistUri, "artist");

    return (
        <Card variant="wow-static" data-featured={featured ? "" : undefined} className="p-5 gap-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">Pick {rank}</div>
                    {artistUrl ? (
                        <a
                            href={artistUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="group inline-flex items-center gap-1.5 text-lg font-semibold text-foreground hover:text-primary"
                        >
                            <span className="truncate">{rec.artist}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
                        </a>
                    ) : (
                        <div className="text-lg font-semibold text-foreground truncate">{rec.artist}</div>
                    )}
                </div>
                <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                    Score {int(rec.score)}
                </Badge>
            </div>

            <p className="text-sm text-muted-foreground leading-relaxed">{rec.reason}</p>

            <ul className="space-y-1.5">
                {rec.evidence.slice(0, 5).map((e) => (
                    <li key={`${e.song}-${e.detail}`} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="truncate text-foreground">{e.song}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.detail}</span>
                    </li>
                ))}
                {rec.evidence.length > 5 && (
                    <li className="text-xs text-muted-foreground">and {rec.evidence.length - 5} more</li>
                )}
            </ul>

            {rec.inCatalog && (
                <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">Songs to try</div>
                    {rec.songsToTry.length === 0 ? (
                        <p className="text-sm text-muted-foreground">You already know all of their top songs.</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {rec.songsToTry.map((s) => (
                                <li key={s.uri} className="flex items-center gap-2.5 text-sm">
                                    {s.cover ? (
                                        <img src={s.cover} alt="" className="h-7 w-7 shrink-0 rounded" loading="lazy" />
                                    ) : (
                                        <div className="h-7 w-7 shrink-0 rounded bg-muted" />
                                    )}
                                    <a
                                        href={spotifyUrl(s.uri, "track") ?? undefined}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="min-w-0 flex-1 truncate text-foreground hover:text-primary"
                                    >
                                        {s.name}
                                    </a>
                                    {s.playcount !== null && (
                                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                            {compact(s.playcount)} plays
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {rec.popularReleases.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {rec.popularReleases.map((a) => (
                        <AlbumChip
                            key={a.uri}
                            name={a.year ? `${a.name} (${a.year})` : a.name}
                            url={spotifyUrl(a.uri, "album")}
                            cover={a.cover}
                        />
                    ))}
                </div>
            ) : (
                rec.albums.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {rec.albums.map((a) => (
                            <AlbumChip key={a.name} name={a.name} url={spotifyUrl(a.uri, "album")} />
                        ))}
                    </div>
                )
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                <span>
                    {int(rec.plays)} {rec.plays === 1 ? "play" : "plays"}
                </span>
                <span>
                    {int(rec.songsHeard)} {rec.songsHeard === 1 ? "song" : "songs"} heard
                </span>
                <span>{int(rec.likedSongs)} liked</span>
                {rec.lastPlayed && <span>Last played {rec.lastPlayed}</span>}
            </div>
        </Card>
    );
}

function AlbumChip({ name, url, cover }: { name: string; url: string | null; cover?: string | null }) {
    const chip = (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground">
            {cover ? (
                <img src={cover} alt="" className="h-4 w-4 rounded-sm" loading="lazy" />
            ) : (
                <Disc3 className="h-3 w-3 text-muted-foreground" />
            )}
            {name}
        </span>
    );

    if (!url) {
        return chip;
    }

    return (
        <a href={url} target="_blank" rel="noreferrer" className="hover:opacity-80">
            {chip}
        </a>
    );
}
