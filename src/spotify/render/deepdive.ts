import type { Arc, ArtistReport, SearchReport, TrackReport } from "@app/spotify/lib/reports/deepdive";
import { bar, c, heading, hours, int, keyValue, line, pct, spark, table } from "@app/spotify/render/text";

function renderArc(arc: Arc, label: string): void {
    line(`  ${c.grey(label)}  ${c.cyan(spark(arc.values))}`);
    // The peak clause is dropped rather than interpolated when it is absent: printing
    // "peak undefined with undefined plays" is what the original did when its arc came back
    // empty, and it read as data rather than as a missing value.
    const span = `  ${arc.fullKeys[0]} → ${arc.fullKeys[arc.fullKeys.length - 1]}, by ${arc.bucket}`;
    line(c.grey(arc.peak ? `${span}; peak ${arc.peak.bucket} with ${arc.peak.plays} plays` : span));
}

export function renderArtist(r: ArtistReport, limit: number): void {
    if (!r.found) {
        line(`nothing played by an artist matching "${r.query}".`);

        return;
    }

    line(heading(`${r.matched[0]} · ${r.head.label}`, r.head.window));
    line(
        keyValue([
            ["plays", `${int(r.plays)}  ${c.grey(`#${r.rank} of ${int(r.totalArtists)} artists`)}`],
            ["time", `${hours(r.ms)}  ${c.grey(`${pct(r.shareOfPlays, 2)} of everything you played`)}`],
            ["first heard", r.first.slice(0, 10)],
            ["last heard", r.last.slice(0, 10)],
            ["distinct tracks", int(r.distinctTracks)],
            [
                "peak month",
                `${int(r.peakWindow?.plays ?? 0)} plays in the 30 days from ${(r.peakWindow?.start ?? "").slice(0, 10)}`,
            ],
            ...(r.genres.length ? ([["genres", r.genres.slice(0, 6).join(", ")]] as [string, string][]) : []),
            ...(r.matched.length > 1
                ? ([["also matched", r.matched.slice(1, 6).join(", ")]] as [string, string][])
                : []),
        ])
    );

    line("");
    if (r.arc) {
        renderArc(r.arc, "arc");
    }

    line(heading("top tracks"));
    const top = r.topTracks.slice(0, limit);
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "track", max: 40 },
                { head: "plays", align: "r" },
                { head: "hours", align: "r" },
                { head: "" },
            ],
            top.map((t, i) => [i + 1, t.track, int(t.plays), hours(t.ms), c.cyan(bar(t.plays, top[0]!.plays, 20))])
        )
    );

    if (r.topAlbums.length > 1) {
        line(heading("top albums"));
        line(
            table(
                [
                    { head: "album", max: 40 },
                    { head: "plays", align: "r" },
                    { head: "tracks", align: "r" },
                ],
                r.topAlbums.slice(0, 10).map((a) => [a.album, int(a.plays), a.tracks])
            )
        );
    }

    line("");
}

export function renderTrack(r: TrackReport): void {
    if (!r.found) {
        line(`nothing played with a title matching "${r.query}".`);

        return;
    }

    line(heading(`${r.track} · ${r.artist}`, r.head.window));
    line(
        keyValue([
            [
                "plays",
                `${int(r.plays)}  ${c.grey(`#${r.rank} of ${int(r.totalSongs)} songs · +${r.shortPlays} under 30s`)}`,
            ],
            ["time", hours(r.ms)],
            ["releases", `${r.releases} ${c.grey("distinct track ids (single, album, compilation)")}`],
            ["first play", r.first.slice(0, 10)],
            ["last play", r.last.slice(0, 10)],
            [
                "peak",
                `${int(r.peakWindow?.plays ?? 0)} plays in the 30 days from ${(r.peakWindow?.start ?? "").slice(0, 10)}`,
            ],
        ])
    );

    line("");
    if (r.arc) {
        renderArc(r.arc, "arc");
    }

    if (r.otherMatches.length) {
        line(heading("other titles that matched"));
        line(
            table(
                [
                    { head: "track", max: 40 },
                    { head: "artist", max: 24 },
                    { head: "plays", align: "r" },
                ],
                r.otherMatches.slice(0, 9).map((a) => [a.track, a.artist, int(a.plays)])
            )
        );
    }

    line("");
}

export function renderSearch(r: SearchReport, limit: number): void {
    if (!r.found) {
        line(`no plays match "${r.query}".`);

        return;
    }

    line(
        heading(
            `search "${r.query}" · ${r.head.label}`,
            `${r.head.window} · ${int(r.plays)} plays, ${int(r.songs.length)} songs, ${int(r.artists.length)} artists`
        )
    );
    line(
        table(
            [
                { head: "track", max: 38 },
                { head: "artist", max: 24 },
                { head: "plays", align: "r" },
                { head: "first" },
                { head: "last" },
            ],
            r.songs
                .slice(0, limit)
                .map((s) => [s.track, s.artist, int(s.plays), s.first.slice(0, 10), s.last.slice(0, 10)])
        )
    );
    line("");
}
