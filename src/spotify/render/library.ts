import type { AuditReport, GemsReport, MainstreamReport, SavesReport } from "@app/spotify/lib/reports/library";
import { bar, c, compact, heading, int, keyValue, line, pct, spark, table } from "@app/spotify/render/text";

export function renderAudit(r: AuditReport, limit: number): void {
    line(heading(`library audit · ${r.head.label}`, r.head.window));
    line(
        keyValue([
            ["liked tracks", int(r.library)],
            ["never played", `${int(r.neverPlayed)}  ${c.grey(pct(r.neverPlayed / Math.max(1, r.library), 0))}`],
            ["played on another release", int(r.neverPlayedButOtherRelease)],
            ["duplicate saves", `${int(r.duplicateSaves)} songs saved more than once`],
            ["played but not liked", `${int(r.topUnliked.length)} songs`],
        ])
    );

    line(heading("played hard, never saved"));
    line(
        table(
            [
                { head: "track", max: 36 },
                { head: "artist", max: 24 },
                { head: "plays", align: "r" },
            ],
            r.topUnliked.slice(0, limit).map((x) => [x.track, x.artist, int(x.plays)])
        )
    );

    if (r.sampleNeverPlayed.length) {
        line(heading("saved and never played"));
        line(
            table(
                [{ head: "track", max: 36 }, { head: "artist", max: 24 }, { head: "added" }],
                r.sampleNeverPlayed.slice(0, 15).map((x) => [x.track, x.artist, (x.addedAt ?? "").slice(0, 10)])
            )
        );
    }

    if (r.duplicates.length) {
        line(heading("saved more than once"));
        line(
            table(
                [
                    { head: "song", max: 50 },
                    { head: "copies", align: "r" },
                ],
                r.duplicates.slice(0, 12).map((d) => [d.song, d.copies])
            )
        );
    }

    line("");
}

export function renderGems(r: GemsReport, limit: number): void {
    line(
        heading(
            `hidden gems · ${r.head.label}`,
            `${r.head.window} · ${r.minPlays}+ of your plays, under ${compact(r.maxGlobal)} global streams`
        )
    );
    line(c.grey("  'share' is your plays as a fraction of the track's entire worldwide stream count\n"));
    line(
        table(
            [
                { head: "track", max: 34 },
                { head: "artist", max: 22 },
                { head: "you", align: "r" },
                { head: "world", align: "r" },
                { head: "your share", align: "r" },
            ],
            r.gems
                .slice(0, limit)
                .map((g) => [
                    g.track,
                    g.artist,
                    int(g.plays),
                    compact(g.playcount),
                    g.ratio >= 0.001 ? pct(g.ratio, 3) : c.grey(pct(g.ratio, 4)),
                ])
        )
    );
    line("");
}

export function renderMainstream(r: MainstreamReport): void {
    if (r.unjoinable) {
        line("no plays overlap the harvested library, so global stream counts cannot be joined.");

        return;
    }

    line(heading(`mainstream check · ${r.head.label}`, r.head.window));
    line(
        c.grey(
            `  joined ${int(r.joinedPlays)} of ${int(r.ofPlays)} plays to a global stream count ` +
                `(${pct(r.joinedPlays / Math.max(1, r.ofPlays), 0)}); only liked tracks carry one\n`
        )
    );
    line(
        keyValue([
            ["median track", `${compact(r.medianGlobal)} global streams`],
            ["quartiles", `${compact(r.quartiles[0])} · ${compact(r.quartiles[1])} · ${compact(r.quartiles[2])}`],
            ["under 1M streams", `${pct(r.underOneMillionShare, 0)} of your plays`],
            ["over 100M streams", `${pct(r.overHundredMillionShare, 0)} of your plays`],
            [
                "agreement with the world",
                `${r.agreementWithWorld.toFixed(2)}  ${c.grey("(rank correlation between your plays and global streams; 0 = unrelated)")}`,
            ],
        ])
    );

    const medians = r.byYear.map((y) => y.medianGlobal);
    line(heading("median popularity of what you played, by year"));
    line(
        c.grey(
            "  stream counts are TODAY's totals, so an old play of a song that later blew up\n" +
                "  is measured with its current number; read the trend, not the absolute level\n"
        )
    );
    const maxMed = Math.max(...medians);
    line(
        table(
            [{ head: "year" }, { head: "plays", align: "r" }, { head: "median streams", align: "r" }, { head: "" }],
            r.byYear.map((y) => [
                y.year,
                int(y.plays),
                compact(y.medianGlobal),
                c.yellow(bar(y.medianGlobal, maxMed, 26)),
            ])
        )
    );
    line(`\n  ${c.grey("trend")}  ${c.cyan(spark(medians))}`);

    line(heading("your most mainstream artists"));
    line(
        table(
            [
                { head: "artist", max: 28 },
                { head: "plays", align: "r" },
                { head: "avg global", align: "r" },
            ],
            r.artists.slice(0, 10).map((a) => [a.artist, int(a.plays), compact(a.avgGlobal)])
        )
    );

    line(heading("your most obscure artists"));
    line(
        table(
            [
                { head: "artist", max: 28 },
                { head: "plays", align: "r" },
                { head: "avg global", align: "r" },
            ],
            r.artists
                .slice(-10)
                .reverse()
                .map((a) => [a.artist, int(a.plays), compact(a.avgGlobal)])
        )
    );
    line("");
}

export function renderSaves(r: SavesReport): void {
    if (r.empty) {
        line("no harvested library for this profile.");

        return;
    }

    const values = r.byMonth.map((m) => m.saved);
    const max = Math.max(...values);
    line(heading(`library growth · ${r.head.label}`, `${int(r.total)} liked tracks`));
    line(
        table(
            [{ head: "month" }, { head: "saved", align: "r" }, { head: "" }],
            r.byMonth.slice(-24).map((m) => [m.month, int(m.saved), c.green(bar(m.saved, max, 30))])
        )
    );
    line(
        `\n  ${c.grey("all time")}  ${c.cyan(spark(values))}   ${c.grey(`${r.byMonth[0]?.month} → ${r.byMonth[r.byMonth.length - 1]?.month}`)}`
    );
    line(`  ${c.grey("busiest")}   ${r.busiest?.month} with ${r.busiest?.saved} saves\n`);
}
