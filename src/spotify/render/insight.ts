import type { DnaReport, ShiftReport } from "@app/spotify/lib/reports/insight";
import { bar, c, heading, int, keyValue, line, pct, table, visibleLength } from "@app/spotify/render/text";

export function renderDna(r: DnaReport): void {
    if (r.empty) {
        line("no plays in that window.");

        return;
    }

    line(heading(`taste DNA · ${r.head.label}`, `${r.head.window} · ${int(r.plays)} plays`));
    const width = 30;
    for (const a of r.axes) {
        const filled = bar(a.value, 1, width);
        const empty = "·".repeat(Math.max(0, width - visibleLength(filled)));
        const colour = a.value >= 0.66 ? c.green : a.value >= 0.33 ? c.yellow : c.grey;
        line(`  ${c.bold(a.axis.padEnd(14))}${colour(filled)}${c.grey(empty)} ${colour(pct(a.value, 0).padStart(5))}`);
        line(`  ${" ".repeat(14)}${c.grey(`${a.low} ← → ${a.high}   ${a.detail}`)}`);
    }

    line("");
}

export function renderShift(r: ShiftReport, limit: number): void {
    line(heading(`taste shift · ${r.head.label}`, `${r.from} → ${r.to}`));
    line(
        keyValue([
            [r.from, `${int(r.plays.from)} plays · ${int(r.artists.from)} artists`],
            [r.to, `${int(r.plays.to)} plays · ${int(r.artists.to)} artists`],
            [
                "continuity",
                `${bar(r.continuity, 1, 24)} ${pct(r.continuity, 1)}  ${c.grey("how much of the old taste survived")}`,
            ],
            ["change", `${bar(r.change, 1, 24)} ${pct(r.change, 1)}`],
        ])
    );

    line(heading("what moved"));
    line(
        table(
            [{ head: "component" }, { head: "kept", align: "r" }, { head: "" }],
            r.components.map((x) => [x.name, pct(x.score, 1), c.cyan(bar(x.score, 1, 22))])
        )
    );

    line(heading("genres that grew and shrank"));
    const shifts = r.genreShifts.slice(0, limit);
    const maxDelta = Math.max(...shifts.map((g) => Math.abs(g.delta)), 0.001);
    line(
        table(
            [
                { head: "genre", max: 24 },
                { head: r.from, align: "r" },
                { head: r.to, align: "r" },
                { head: "change", align: "r" },
                { head: "" },
            ],
            shifts.map((g) => [
                g.genre,
                pct(g.from, 1),
                pct(g.to, 1),
                (g.delta >= 0 ? c.green : c.red)(`${g.delta >= 0 ? "+" : ""}${pct(g.delta, 1)}`),
                g.delta >= 0
                    ? `${" ".repeat(12)}${c.green(bar(g.delta, maxDelta, 12))}`
                    : // Pad the BAR, then colour it. Padding afterwards counts the ANSI escape
                      // bytes toward the width, so the string is already "long enough" and no
                      // padding is added — negative bars rendered flush left against a column of
                      // right-aligned positive ones.
                      c.red(bar(-g.delta, maxDelta, 12).padStart(12)),
            ])
        )
    );

    line(heading("only in one window", "present in one period and absent from the other; not first-ever discoveries"));
    const dropped = r.droppedArtists;
    const gained = r.gainedArtists;
    line(
        table(
            [
                { head: `only in ${r.from}`, max: 28 },
                { head: "plays", align: "r" },
                { head: `only in ${r.to}`, max: 28 },
                { head: "plays", align: "r" },
            ],
            Array.from({ length: Math.min(limit, Math.max(dropped.length, gained.length)) }, (_, i) => [
                dropped[i]?.artist ?? "",
                dropped[i] ? int(dropped[i]!.plays) : "",
                gained[i]?.artist ?? "",
                gained[i] ? int(gained[i]!.plays) : "",
            ])
        )
    );
    line("");
}
