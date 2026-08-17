import type { CalendarReport, ClockReport, SeasonsReport, TimelineReport } from "@app/spotify/lib/reports/time";
import { MONTHS, WEEKDAYS } from "@app/spotify/lib/reports/time";
import { bar, c, heading, heat, hours, int, keyValue, line, pct, spark, table } from "@app/spotify/render/text";

const NO_PLAYS = "no plays in that window.";

export function renderTimeline(r: TimelineReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    const values = r.points.map((p) => p.value);
    const max = Math.max(...values);
    line(heading(`timeline · ${r.head.label}`, `${r.head.window} · by ${r.bucket}`));
    line(
        c.grey(
            `  peak ${r.peak?.bucket} with ${r.metric === "ms" ? hours(r.peak?.value ?? 0) : `${int(r.peak?.value ?? 0)} plays`}\n`
        )
    );
    line(
        table(
            [{ head: r.bucket }, { head: r.metric === "ms" ? "hours" : "plays", align: "r" }, { head: "" }],
            r.points.map((p) => [
                p.bucket,
                r.metric === "ms" ? hours(p.value) : int(p.value),
                c.cyan(bar(p.value, max, 40)),
            ])
        )
    );
}

export function renderClock(r: ClockReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    const maxCell = Math.max(...r.byWeekdayHour.flat());
    line(heading(`listening clock · ${r.head.label}`, `${r.head.window} · ${r.head.timezone}`));
    line(`      ${c.grey([...Array(24).keys()].map((h) => String(h).padStart(2, "0")[0]).join(" "))}`);
    line(`      ${c.grey([...Array(24).keys()].map((h) => String(h).padStart(2, "0")[1]).join(" "))}`);
    for (let d = 0; d < 7; d++) {
        const cells = r.byWeekdayHour[d]!.map((v) => heat(v, maxCell)).join(" ");
        line(`  ${c.grey(WEEKDAYS[d]!)} ${cells}  ${c.grey(int(r.byWeekday[d]!))}`);
    }

    line("");
    line(
        keyValue([
            [
                "peak hour",
                `${String(r.peakHour).padStart(2, "0")}:00  ${c.grey(`${int(r.byHour[r.peakHour]!)} plays`)}`,
            ],
            ["night owl", `${pct(r.nightShare, 1)} of plays between 00:00 and 05:00`],
            ["office hours", `${pct(r.officeShare, 1)} between 09:00 and 18:00`],
            ["weekend", `${pct(r.weekendShare, 1)} of plays`],
            ["hour shape", c.cyan(spark(r.byHour))],
        ])
    );
    line("");
}

export function renderCalendar(r: CalendarReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    line(heading(`calendar · ${r.head.label}`, `${r.head.window} · darkest cell = ${int(r.max)} plays`));

    for (const y of r.years) {
        const start = Date.UTC(Number(y), 0, 1);
        const end = Date.UTC(Number(y) + 1, 0, 1);
        const offset = (new Date(start).getUTCDay() + 6) % 7;
        const weeks = Math.ceil((offset + (end - start) / 86400000) / 7);

        const monthLabel = new Array<string>(weeks).fill("  ");
        for (let m = 0; m < 12; m++) {
            const col = Math.floor((offset + (Date.UTC(Number(y), m, 1) - start) / 86400000) / 7);
            if (col < weeks) {
                monthLabel[col] = MONTHS[m]!.slice(0, 2);
            }
        }

        let total = 0;
        let active = 0;
        const rows: string[] = [];
        for (let wd = 0; wd < 7; wd++) {
            let line = "";
            for (let w = 0; w < weeks; w++) {
                const dayIndex = w * 7 + wd - offset;
                const t = start + dayIndex * 86400000;
                if (dayIndex < 0 || t >= end) {
                    line += "  ";
                    continue;
                }

                const v = r.days[new Date(t).toISOString().slice(0, 10)] ?? 0;
                total += v;
                if (v) {
                    active++;
                }

                line += `${heat(v, r.max)} `;
            }

            rows.push(`  ${c.grey(WEEKDAYS[wd]!)} ${line}`);
        }

        line(`\n${c.bold(y)}  ${c.grey(`${int(total)} plays on ${active} days`)}`);
        line(`      ${c.grey(monthLabel.join(""))}`);
        for (const row of rows) {
            line(row);
        }
    }

    line("");
}

export function renderSeasons(r: SeasonsReport): void {
    if (r.empty) {
        line(NO_PLAYS);

        return;
    }

    const max = Math.max(...r.byMonth.map((m) => m.plays));
    line(heading(`seasonal rhythm · ${r.head.label}`, `${r.head.window} · every year stacked`));
    line(
        table(
            [{ head: "month" }, { head: "plays", align: "r" }, { head: "hours", align: "r" }, { head: "" }],
            r.byMonth.map((m) => [m.month, int(m.plays), hours(m.ms), c.cyan(bar(m.plays, max, 34))])
        )
    );

    if (r.bySeason.some((s) => s.topGenres.length)) {
        line(heading("what each season sounds like"));
        line(
            table(
                [{ head: "season" }, { head: "plays", align: "r" }, { head: "dominant genres", max: 60 }],
                r.bySeason.map((s) => [
                    s.season,
                    int(s.plays),
                    s.topGenres.map((g) => `${g.genre} ${c.grey(pct(g.share, 0))}`).join(", "),
                ])
            )
        );
    }

    line("");
}
