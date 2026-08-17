import type { SummaryReport } from "@app/spotify/lib/reports/summary";
import { bar, c, heading, hours, int, keyValue, line, pct, spark, table } from "@app/spotify/render/text";

export function renderSummary(r: SummaryReport): void {
    if (r.empty) {
        line("no plays in that window.");

        return;
    }

    line(heading(`listening summary · ${r.head.label}`, r.head.window));
    line(
        keyValue([
            ["span", `${r.span.from.slice(0, 10)} to ${r.span.to.slice(0, 10)}  (${int(r.span.days)} days)`],
            ["plays", `${int(r.totals.plays)}  ${c.grey(`+${int(r.totals.shortPlays)} under 30s`)}`],
            ["time", `${hours(r.totals.ms)}  ${c.grey(`= ${(r.totals.ms / 86400000).toFixed(1)} full days`)}`],
            [
                "distinct",
                `${int(r.totals.tracks)} tracks · ${int(r.totals.artists)} artists · ${int(r.totals.albums)} albums`,
            ],
            ["sessions", `${int(r.totals.sessions)} sittings, median ${Math.round(r.totals.medianSessionMinutes)} min`],
            [
                "active days",
                `${int(r.totals.activeDays)} of ${int(r.span.days)}  ${c.grey(pct(r.shape.activeDayShare, 0))}  ·  ${r.shape.playsPerActiveDay.toFixed(1)} plays per active day`,
            ],
            [
                "longest streak",
                r.streak ? `${r.streak.length} days  ${c.grey(`${r.streak.start} to ${r.streak.end}`)}` : "—",
            ],
            [
                "diversity",
                `${bar(r.shape.diversity, 1, 16)} ${pct(r.shape.diversity, 0)} ${c.grey("(1.0 = every artist played equally)")}`,
            ],
            [
                "concentration",
                `${bar(r.shape.concentration, 1, 16)} ${pct(r.shape.concentration, 0)} ${c.grey("(Gini over artist plays)")}`,
            ],
            ...(r.shape.likedShareOfPlays !== null
                ? ([
                      [
                          "from library",
                          `${pct(r.shape.likedShareOfPlays, 0)} of plays are liked tracks ${c.grey(`(${int(r.shape.likedTracks)} liked)`)}`,
                      ],
                  ] as [string, string][])
                : []),
        ])
    );

    const maxPlays = Math.max(...r.years.map((y) => y.plays));
    line(heading("by year"));
    line(
        table(
            [
                { head: "year" },
                { head: "plays", align: "r" },
                { head: "hours", align: "r" },
                { head: "artists", align: "r" },
                { head: "new", align: "r" },
                { head: "top artist", max: 22 },
                { head: "" },
            ],
            r.years.map((y) => [
                y.year,
                int(y.plays),
                hours(y.ms),
                int(y.artists),
                c.green(`+${y.newArtists}`),
                y.topArtist ?? "",
                c.cyan(bar(y.plays, maxPlays, 24)),
            ])
        )
    );

    if (r.topGenres.length) {
        line(heading("dominant genres"));
        const top = r.topGenres.slice(0, 8);
        line(
            table(
                [
                    { head: "genre", max: 24 },
                    { head: "share", align: "r" },
                    { head: "plays", align: "r" },
                    { head: "" },
                ],
                top.map((g) => [g.genre, pct(g.share, 1), int(g.plays), c.magenta(bar(g.plays, top[0]!.plays, 24))])
            )
        );
    }

    const months = r.monthly.map((m) => m.plays);
    line(`\n  ${c.grey("monthly plays")}  ${c.cyan(spark(months))}`);
    line(
        c.grey(
            `  ${r.monthly[0]?.month ?? ""}${" ".repeat(Math.max(1, r.monthly.length - 14))}${r.monthly[r.monthly.length - 1]?.month ?? ""}\n`
        )
    );
}
