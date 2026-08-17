import type {
    BehaviorReport,
    BreakdownRow,
    SessionsReport,
    SkipsReport,
    StreaksReport,
} from "@app/spotify/lib/reports/behavior";
import { bar, c, heading, hours, int, keyValue, line, pct, table } from "@app/spotify/render/text";

const NO_PLAYS = "no plays in that window.";
const share = (n: number, total: number) => pct(n / Math.max(1, total), 1);

function renderBreakdown(title: string, rows: BreakdownRow[], total: number): void {
    if (!rows.length) {
        return;
    }

    const max = rows[0]!.plays;
    line(heading(title));
    line(
        table(
            [
                { head: "", max: 24 },
                { head: "plays", align: "r" },
                { head: "share", align: "r" },
                { head: "hours", align: "r" },
                { head: "" },
            ],
            rows.map((v) => [v.key, int(v.plays), share(v.plays, total), hours(v.ms), c.cyan(bar(v.plays, max, 22))])
        )
    );
}

export function renderBehavior(r: BehaviorReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`listening behaviour · ${r.head.label}`, r.head.window));
    line(
        keyValue([
            ["events", `${int(r.events)}  ${c.grey(`${int(r.plays)} cleared 30s`)}`],
            ["shuffle", `${bar(r.rates.shuffle, 1, 16)} ${pct(r.rates.shuffle, 1)} of plays`],
            ["offline", `${bar(r.rates.offline, 1, 16)} ${pct(r.rates.offline, 1)}`],
            [
                "private",
                `${bar(r.rates.incognito, 1, 16)} ${pct(r.rates.incognito, 1)} ${c.grey("(incognito sessions)")}`,
            ],
            ["played to the end", `${bar(r.rates.completed, 1, 16)} ${pct(r.rates.completed, 1)}`],
            ["skipped forward", `${bar(r.rates.forwardEnd, 1, 16)} ${pct(r.rates.forwardEnd, 1)}`],
        ])
    );

    renderBreakdown("devices", r.platforms.slice(0, 12), r.plays);
    renderBreakdown("countries", r.countries.slice(0, 8), r.plays);
    renderBreakdown("how a track starts", r.reasonStart.slice(0, 8), r.events);
    renderBreakdown("how a track ends", r.reasonEnd.slice(0, 8), r.events);
    line("");
}

export function renderSkips(r: SkipsReport, limit: number): void {
    line(heading(`skip rate · ${r.head.label}`, `${r.head.window} · overall ${pct(r.overallRate, 1)}`));
    line(
        c.grey(
            `  a skip is a start that ended under 30s or on the forward button; at least ${r.minStarts} starts to qualify\n`
        )
    );

    const cols = [
        { head: "artist", max: 30 },
        { head: "starts", align: "r" as const },
        { head: "skips", align: "r" as const },
        { head: "rate", align: "r" as const },
        { head: "" },
    ];

    line(c.bold("  most skipped"));
    line(
        table(
            cols,
            r.artists
                .slice(0, limit)
                .map((x) => [x.artist, int(x.starts), int(x.skips), pct(x.rate, 0), c.red(bar(x.rate, 1, 20))])
        )
    );

    line(`\n${c.bold("  most finished")}`);
    line(
        table(
            cols,
            r.artists
                .slice(-limit)
                .reverse()
                .map((x) => [x.artist, int(x.starts), int(x.skips), pct(x.rate, 0), c.green(bar(1 - x.rate, 1, 20))])
        )
    );
    line("");
}

export function renderSessions(r: SessionsReport, limit: number): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`sittings · ${r.head.label}`, `${r.head.window} · a gap over ${r.gapMinutes} min starts a new one`));
    line(
        keyValue([
            ["sittings", int(r.count)],
            ["median length", `${r.medianMinutes.toFixed(0)} min`],
            ["mean length", `${r.meanMinutes.toFixed(0)} min`],
            ["per active day", r.perActiveDay.toFixed(1)],
            ["median tracks", r.medianTracks.toFixed(0)],
        ])
    );

    line(heading("longest sittings"));
    line(
        table(
            [
                { head: "started" },
                { head: "length", align: "r" },
                { head: "tracks", align: "r" },
                { head: "artists", align: "r" },
                { head: "mostly", max: 26 },
            ],
            r.sessions
                .slice(0, limit)
                .map((s) => [
                    s.start.slice(0, 16).replace("T", " "),
                    `${Math.round(s.minutes)} min`,
                    int(s.tracks),
                    int(s.artists),
                    s.topArtist,
                ])
        )
    );
    line("");
}

export function renderStreaks(r: StreaksReport, limit: number): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`streaks · ${r.head.label}`, r.head.window));
    line(
        keyValue([
            ["active days", int(r.activeDays)],
            [
                "longest streak",
                r.longest ? `${r.longest.length} days  ${c.grey(`${r.longest.start} to ${r.longest.end}`)}` : "—",
            ],
            ["latest streak", r.current ? `${r.current.length} days  ${c.grey(`ending ${r.current.end}`)}` : "—"],
        ])
    );

    line(heading("longest runs"));
    const top = r.runs.slice(0, limit);
    line(
        table(
            [{ head: "days", align: "r" }, { head: "from" }, { head: "to" }, { head: "" }],
            top.map((x) => [int(x.length), x.start, x.end, c.green(bar(x.length, top[0]?.length ?? 1, 26))])
        )
    );

    line(heading("longest silences"));
    // `limit` is the caller's --top. Hardcoding 10 made it govern "longest runs" but not
    // "longest silences" in the same report.
    const worst = r.gaps.slice(0, limit);
    line(
        table(
            [{ head: "days", align: "r" }, { head: "after" }, { head: "back on" }, { head: "" }],
            worst.map((g) => [int(g.days), g.from, g.to, c.red(bar(g.days, worst[0]?.days ?? 1, 26))])
        )
    );
    line("");
}
