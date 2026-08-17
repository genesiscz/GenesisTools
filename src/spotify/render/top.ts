import type { TopReport } from "@app/spotify/lib/reports/top";
import { type Column, c, heading, hours, int, line, pct, spark, table } from "@app/spotify/render/text";

/** Every genre view prints this instead of a table of zeros. */
export function renderNoGenreData(profile: string): void {
    line(c.yellow(`profile "${profile}" has no genre data.`));
    line(c.grey("  Genres come from MusicBrainz and Last.fm, not from Spotify. Run:"));
    line(c.grey(`    tools spotify enrich --profile ${profile}`));
}

export function renderTop(r: TopReport): void {
    if (r.kind === "genres") {
        renderTopGenres(r);

        return;
    }

    const shown = r.rows.slice(0, r.limit);
    line(heading(`top ${r.kind} · ${r.head.label}`, r.head.window));
    line(
        c.grey(`  ${int(r.totals.plays)} plays · ${hours(r.totals.ms)} · ${int(r.totals.distinct)} distinct ${r.kind}`)
    );

    const cols: Column[] = [
        { head: "#", align: "r" },
        { head: r.kind === "artists" ? "artist" : r.kind === "albums" ? "album" : "track", max: 40 },
    ];
    if (r.kind !== "artists") {
        cols.push({ head: "artist", max: 24 });
    }

    cols.push({ head: "plays", align: "r" }, { head: "hours", align: "r" });
    if (r.kind === "songs") {
        cols.push({ head: "rel", align: "r" });
    }

    if (r.kind === "artists" || r.kind === "albums") {
        cols.push({ head: "tracks", align: "r" });
    }

    const withTrend = r.trendBucket !== null;
    if (withTrend) {
        cols.push({ head: "trend" });
    }

    line(
        table(
            cols,
            shown.map((a, i) => {
                const row: (string | number)[] = [i + 1, a.name];
                if (r.kind !== "artists") {
                    row.push(a.artist);
                }

                row.push(int(a.plays), hours(a.ms));
                if (r.kind === "songs" || r.kind === "artists" || r.kind === "albums") {
                    row.push(a.releases);
                }

                if (withTrend) {
                    row.push(c.cyan(spark(a.trend ?? [])));
                }

                return row;
            })
        )
    );
}

function renderTopGenres(r: TopReport): void {
    if (r.genresMissing) {
        renderNoGenreData(r.head.profile);

        return;
    }

    const total = r.coverage.taggedPlays + r.coverage.untaggedPlays;
    const shown = r.genres.slice(0, r.limit);
    line(heading(`top genres · ${r.head.label}`, r.head.window));
    line(
        c.grey(
            `  ${int(r.coverage.taggedPlays)} of ${int(total)} plays carry a genre ` +
                `(${pct(r.coverage.taggedPlays / Math.max(1, total), 0)}); a play counts once per genre it has`
        )
    );
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "genre", max: 28 },
                { head: "plays", align: "r" },
                { head: "hours", align: "r" },
                { head: "share", align: "r" },
                { head: "tracks", align: "r" },
                { head: "artists", align: "r" },
            ],
            shown.map((g, i) => [
                i + 1,
                g.genre,
                int(g.plays),
                hours(g.ms),
                pct(g.share, 1),
                int(g.tracks),
                int(g.artists),
            ])
        )
    );
}
