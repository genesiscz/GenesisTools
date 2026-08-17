import type { WrappedReport } from "@app/spotify/lib/reports/wrapped";
import { bar, c, heading, hours, int, keyValue, line, pct, spark, table } from "@app/spotify/render/text";

export function renderWrapped(r: WrappedReport): void {
    line(
        heading(
            `${r.year} wrapped · ${r.head.label}`,
            `${int(r.plays)} plays · ${r.minutes.toLocaleString("en-US")} minutes`
        )
    );

    const delta = r.vsPreviousYear;
    line(
        keyValue([
            ["time", `${hours(r.ms)}  ${c.grey(`= ${(r.ms / 86400000).toFixed(1)} days of continuous audio`)}`],
            [
                `vs ${r.year - 1}`,
                delta === null || !r.previous
                    ? "—"
                    : `${delta >= 0 ? c.green(`+${pct(delta, 0)}`) : c.red(pct(delta, 0))}  ${c.grey(`${int(r.previous.plays)} plays, ${hours(r.previous.ms)}`)}`,
            ],
            [
                "distinct",
                `${int(r.distinct.tracks)} tracks · ${int(r.distinct.artists)} artists · ${int(r.distinct.albums)} albums`,
            ],
            [
                "active days",
                `${int(r.activeDays)} of ${r.year === new Date().getUTCFullYear() ? "so far" : "365"}  ${c.grey(`${(r.plays / Math.max(1, r.activeDays)).toFixed(1)} plays per active day`)}`,
            ],
            ["sittings", int(r.sessions)],
            [
                "new artists",
                `${c.green(int(r.newArtists))}  ${c.grey(`${pct(r.newArtists / Math.max(1, r.distinct.artists), 0)} of the year's artists were first-timers`)}`,
            ],
            ["carried over", `${int(r.carriedOver)} artists also played in ${r.year - 1}`],
            ["biggest day", r.topDay ? `${r.topDay.date}  ${c.grey(`${r.topDay.plays} plays`)}` : "—"],
        ])
    );

    line(heading("top songs"));
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "track", max: 40 },
                { head: "artist", max: 24 },
                { head: "plays", align: "r" },
                { head: "" },
            ],
            r.topSongs.map((s, i) => [
                i + 1,
                s.track,
                s.artist,
                int(s.plays),
                c.cyan(bar(s.plays, r.topSongs[0]!.plays, 18)),
            ])
        )
    );

    line(heading("top artists"));
    line(
        table(
            [
                { head: "#", align: "r" },
                { head: "artist", max: 30 },
                { head: "plays", align: "r" },
                { head: "hours", align: "r" },
                { head: "" },
            ],
            r.topArtists.map((a, i) => [
                i + 1,
                a.artist,
                int(a.plays),
                hours(a.ms),
                c.magenta(bar(a.plays, r.topArtists[0]!.plays, 18)),
            ])
        )
    );

    if (r.topGenres.length) {
        line(heading("top genres"));
        line(
            table(
                [{ head: "#", align: "r" }, { head: "genre", max: 26 }, { head: "share", align: "r" }, { head: "" }],
                r.topGenres
                    .slice(0, 8)
                    .map((g, i) => [i + 1, g.genre, pct(g.share, 1), c.yellow(bar(g.plays, r.topGenres[0]!.plays, 20))])
            )
        );
    }

    if (r.discoveries.length) {
        line(heading("best discoveries", "artists you met this year"));
        line(
            table(
                [{ head: "artist", max: 30 }, { head: "plays", align: "r" }, { head: "first heard" }],
                r.discoveries.map((d) => [d.artist, int(d.plays), d.first.slice(0, 10)])
            )
        );
    }

    const months = r.byMonth.map((m) => m.plays);
    const maxMonth = Math.max(...months);
    line(heading("the year month by month"));
    line(
        table(
            [{ head: "month" }, { head: "plays", align: "r" }, { head: "" }],
            r.byMonth.map((m) => [m.month, int(m.plays), c.cyan(bar(m.plays, maxMonth, 34))])
        )
    );

    line(`\n  ${c.grey("shape")}  ${c.cyan(spark(months))}\n`);
}
