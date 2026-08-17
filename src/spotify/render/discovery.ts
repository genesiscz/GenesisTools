import type {
    DiscoveryReport,
    FirstsReport,
    ForgottenReport,
    LoyaltyReport,
    ObsessionsReport,
} from "@app/spotify/lib/reports/discovery";
import { bar, c, heading, int, line, pct, table } from "@app/spotify/render/text";

const NO_PLAYS = "no plays in that window.";

export function renderDiscovery(r: DiscoveryReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`discovery · ${r.head.label}`, r.head.window));
    line(
        c.grey(
            "  novelty = share of that year's plays that went to an artist first heard that same year\n" +
                "  the first year on record always reads 100%: nothing precedes it\n"
        )
    );
    const maxNew = Math.max(...r.years.map((y) => y.newArtists));
    line(
        table(
            [
                { head: "year" },
                { head: "plays", align: "r" },
                { head: "artists", align: "r" },
                { head: "new artists", align: "r" },
                { head: "new tracks", align: "r" },
                { head: "novelty", align: "r" },
                { head: "" },
            ],
            r.years.map((y) => [
                y.year,
                int(y.plays),
                int(y.artists),
                int(y.newArtists),
                int(y.newTracks),
                pct(y.noveltyShare, 0),
                c.green(bar(y.newArtists, maxNew, 24)),
            ])
        )
    );
    line("");
}

export function renderFirsts(r: FirstsReport): void {
    line(
        heading(
            `first encounters · ${r.head.label}`,
            `${r.head.window} · artists with ${r.minPlays}+ plays, oldest first`
        )
    );
    line(
        table(
            [
                { head: "first heard" },
                { head: "artist", max: 28 },
                { head: "plays", align: "r" },
                { head: "still?", align: "r" },
                { head: "years", align: "r" },
            ],
            r.artists.map((x) => [
                x.first.slice(0, 10),
                x.artist,
                int(x.plays),
                x.stillActive ? c.green("yes") : c.grey(x.last.slice(0, 7)),
                x.yearsActive.toFixed(1),
            ])
        )
    );
    line("");
}

export function renderForgotten(r: ForgottenReport, limit: number): void {
    line(
        heading(
            `forgotten favourites · ${r.head.label}`,
            `${r.minPlays}+ plays, silent ${r.quietMonths}+ months · ${int(r.tracks.length)} tracks`
        )
    );
    line(
        table(
            [
                { head: "track", max: 34 },
                { head: "artist", max: 22 },
                { head: "plays", align: "r" },
                { head: "last played" },
                { head: "silent", align: "r" },
            ],
            r.tracks
                .slice(0, limit)
                .map((x) => [x.track, x.artist, int(x.plays), x.lastPlayed.slice(0, 10), `${x.silentMonths} mo`])
        )
    );
    line("");
}

export function renderObsessions(r: ObsessionsReport, limit: number): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`obsessions · ${r.head.label}`, `${r.head.window} · densest ${r.windowDays}-day window per song`));
    const top = r.hardest.slice(0, limit);
    line(
        table(
            [
                { head: "track", max: 32 },
                { head: "artist", max: 20 },
                { head: "peak", align: "r" },
                { head: "of total", align: "r" },
                { head: "when" },
                { head: "" },
            ],
            top.map((p) => [
                p.track,
                p.artist,
                int(p.peakPlays),
                pct(p.intensity, 0),
                p.windowStart.slice(0, 10),
                c.magenta(bar(p.peakPlays, r.hardest[0]?.peakPlays ?? 1, 18)),
            ])
        )
    );

    line(heading("song of the month"));
    line(
        table(
            [
                { head: "month" },
                { head: "track", max: 34 },
                { head: "artist", max: 22 },
                { head: "plays in window", align: "r" },
            ],
            r.byMonth.slice(-24).map((p) => [p.month, p.track, p.artist, int(p.peakPlays)])
        )
    );
    line("");
}

export function renderLoyalty(r: LoyaltyReport, limit: number): void {
    line(heading(`loyalty · ${r.head.label}`, `${r.head.window} · artists with ${r.minPlays}+ plays`));
    line(
        c.grey(
            "  months = distinct months with at least one play; consistency = months active / months since the first play\n"
        )
    );
    line(c.bold("  longest companions"));
    line(
        table(
            [
                { head: "artist", max: 26 },
                { head: "plays", align: "r" },
                { head: "months", align: "r" },
                { head: "span", align: "r" },
                { head: "consistency", align: "r" },
                { head: "since" },
                { head: "" },
            ],
            r.longestCompanions
                .slice(0, limit)
                .map((x) => [
                    x.artist,
                    int(x.plays),
                    int(x.activeMonths),
                    int(x.spanMonths),
                    pct(x.consistency, 0),
                    x.first.slice(0, 7),
                    x.stillActive ? c.green("active") : c.grey("dormant"),
                ])
        )
    );

    line(`\n${c.bold("  intense phases that ended")}`);
    line(
        table(
            [
                { head: "artist", max: 26 },
                { head: "plays", align: "r" },
                { head: "months", align: "r" },
                { head: "plays per month", align: "r" },
                { head: "ran" },
            ],
            r.endedPhases
                .slice(0, 12)
                .map((x) => [
                    x.artist,
                    int(x.plays),
                    int(x.activeMonths),
                    (x.plays / x.activeMonths).toFixed(1),
                    `${x.first.slice(0, 7)} → ${x.last.slice(0, 7)}`,
                ])
        )
    );
    line("");
}
