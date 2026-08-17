import type { BlendReport, CompatReport, CompatTimelineReport, GiftReport } from "@app/spotify/lib/reports/compat";
import { bar, c, heading, hours, int, keyValue, line, pct, scoreBar, spark, table } from "@app/spotify/render/text";

function nothingToCompare(side: string): void {
    line(`${side} has no plays in that window, so there is nothing to compare.`);
}

export function renderCompat(r: CompatReport, limit: number): void {
    if (r.emptySide) {
        nothingToCompare(r.emptySide);

        return;
    }

    line(heading(`compatibility · ${r.a.label} × ${r.b.label}`, r.window));
    line(`  ${scoreBar(r.compatibility, 34)}\n`);
    line(
        keyValue([
            [
                r.a.label,
                `${int(r.a.plays)} plays · ${hours(r.a.ms)} · ${int(r.a.artists)} artists · ${int(r.a.songs)} songs`,
            ],
            [
                r.b.label,
                `${int(r.b.plays)} plays · ${hours(r.b.ms)} · ${int(r.b.artists)} artists · ${int(r.b.songs)} songs`,
            ],
        ])
    );

    line(heading("what the score is made of"));
    line(
        table(
            [
                { head: "component" },
                { head: "score", align: "r" },
                { head: "weight", align: "r" },
                { head: "" },
                { head: "meaning", max: 44 },
            ],
            r.components.map((x) => [
                x.name,
                pct(x.score, 1),
                pct(x.weight, 0),
                c.cyan(bar(x.score, 1, 16)),
                c.grey(x.detail),
            ])
        )
    );

    line(heading("common ground", `${int(r.sharedArtists)} artists and ${int(r.sharedSongs)} songs in both histories`));
    line(
        table(
            [
                { head: "artist", max: 26 },
                { head: r.a.label, align: "r" },
                { head: r.b.label, align: "r" },
                { head: "" },
            ],
            r.topShared.slice(0, limit).map((t) => {
                const max = Math.max(t.aShare, t.bShare);

                return [
                    t.artist,
                    pct(t.aShare, 2),
                    pct(t.bShare, 2),
                    `${c.blue(bar(t.aShare, max, 12))}${c.grey("|")}${c.magenta(bar(t.bShare, max, 12))}`,
                ];
            })
        )
    );

    if (r.sharedSongRows.length) {
        line(heading("songs you both play"));
        line(
            table(
                [
                    { head: "song", max: 52 },
                    { head: r.a.label, align: "r" },
                    { head: r.b.label, align: "r" },
                ],
                r.sharedSongRows.slice(0, limit).map((s) => [s.song, pct(s.aShare, 3), pct(s.bShare, 3)])
            )
        );
    }

    line(heading("private territory"));
    line(
        table(
            [
                { head: `only ${r.a.label}`, max: 30 },
                { head: "share", align: "r" },
                { head: `only ${r.b.label}`, max: 30 },
                { head: "share", align: "r" },
            ],
            Array.from({ length: Math.min(10, Math.max(r.onlyA.length, r.onlyB.length)) }, (_, i) => [
                r.onlyA[i]?.artist ?? "",
                r.onlyA[i] ? pct(r.onlyA[i]!.share, 2) : "",
                r.onlyB[i]?.artist ?? "",
                r.onlyB[i] ? pct(r.onlyB[i]!.share, 2) : "",
            ])
        )
    );

    if (r.genreProfile.length) {
        line(heading("genre profiles side by side"));
        const rows = r.genreProfile.slice(0, limit);
        const maxShare = Math.max(...rows.flatMap((g) => [g.a, g.b]));
        line(
            table(
                [
                    { head: "genre", max: 22 },
                    { head: r.a.label, align: "r" },
                    { head: "", max: 14 },
                    { head: "", max: 14 },
                    { head: r.b.label, align: "r" },
                ],
                rows.map((g) => [
                    g.genre,
                    pct(g.a, 1),
                    c.blue(bar(g.a, maxShare, 12).padStart(12)),
                    c.magenta(bar(g.b, maxShare, 12)),
                    pct(g.b, 1),
                ])
            )
        );
    }

    line(`\n  ${c.grey(r.verdict)}\n`);
}

export function renderCompatTimeline(r: CompatTimelineReport): void {
    if (r.emptySide) {
        nothingToCompare(r.emptySide);

        return;
    }

    line(heading(`compatibility over time · ${r.a.label} × ${r.b.label}`, `${r.window} · by ${r.bucket}`));
    const scored = r.points.filter((p) => p.compatibility !== null);
    if (!scored.length) {
        line(
            c.yellow(`  no ${r.bucket} has ${r.minPlays}+ plays on both sides. Try --bucket year or --min-plays 10.\n`)
        );

        return;
    }

    line(
        keyValue([
            ["average", `${pct(r.average ?? 0, 1)} across ${scored.length} ${r.bucket}s`],
            ["closest", `${r.closest?.bucket}  ${pct(r.closest?.compatibility ?? 0, 1)}`],
            ["furthest", `${r.furthest?.bucket}  ${pct(r.furthest?.compatibility ?? 0, 1)}`],
            ["trend", c.cyan(spark(scored.map((p) => p.compatibility!)))],
        ])
    );
    line("");

    line(
        table(
            [
                { head: r.bucket },
                { head: r.a.label, align: "r" },
                { head: r.b.label, align: "r" },
                { head: "compat", align: "r" },
                { head: "" },
                { head: "genre", align: "r" },
                { head: "artists", align: "r" },
            ],
            r.points.map((p) => [
                p.bucket,
                int(p.aPlays),
                int(p.bPlays),
                p.compatibility === null ? c.grey("—") : pct(p.compatibility, 1),
                p.compatibility === null ? c.grey("too few plays") : scoreBar(p.compatibility, 18),
                p.components[0] ? pct(p.components[0].score, 0) : "",
                p.components[1] ? pct(p.components[1].score, 0) : "",
            ])
        )
    );
    line("");
}

export function renderBlend(r: BlendReport, limit: number): void {
    line(
        heading(
            `blend · ${r.a.label} × ${r.b.label}`,
            `${r.window} · ${int(r.tracks.length)} songs both of you play at least ${r.minPlays}×`
        )
    );
    line(c.grey("  ranked by harmonic mean of each side's play share, so one-sided hits sink\n"));
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "song", max: 54 },
                { head: r.a.label, align: "r" },
                { head: r.b.label, align: "r" },
                { head: "match" },
            ],
            r.tracks
                .slice(0, limit)
                .map((t, i) => [
                    i + 1,
                    t.song,
                    int(t.aPlays),
                    int(t.bPlays),
                    c.green(bar(t.score, r.tracks[0]?.score ?? 1, 14)),
                ])
        )
    );
    line("");
}

export function renderGift(r: GiftReport, limit: number): void {
    line(heading(`gift · ${r.from.label} → ${r.to.label}`, r.window));
    line(
        c.grey(
            `  tracks ${r.from.label} plays that ${r.to.label} has never played once, ` +
                `weighted by how much ${r.to.label} already likes the artist and the genre\n`
        )
    );
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "track", max: 34 },
                { head: "artist", max: 22 },
                { head: "you", align: "r" },
                { head: "artist fit", align: "r" },
                { head: "genre fit", align: "r" },
                { head: "" },
            ],
            r.candidates
                .slice(0, limit)
                .map((x, i) => [
                    i + 1,
                    x.track,
                    x.artist,
                    int(x.yourPlays),
                    pct(x.theirArtistAffinity, 0),
                    pct(x.theirGenreAffinity, 0),
                    c.green(bar(x.score, r.candidates[0]?.score ?? 1, 12)),
                ])
        )
    );
    line("");
}
