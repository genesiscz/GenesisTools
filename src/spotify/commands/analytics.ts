/**
 * Every history-only report: summary, rankings, time shapes, behaviour, biography,
 * composites, deep dives and wrapped.
 */
import { common, emit, limitOf } from "@app/spotify/commands/_shared";
import type { CommonOpts } from "@app/spotify/lib/context";
import { toCsv } from "@app/spotify/lib/csv";
import { behaviorReport, sessionsReport, skipsReport, streaksReport } from "@app/spotify/lib/reports/behavior";
import { artistReport, searchReport, trackReport } from "@app/spotify/lib/reports/deepdive";
import {
    discoveryReport,
    firstsReport,
    forgottenReport,
    loyaltyReport,
    obsessionsReport,
} from "@app/spotify/lib/reports/discovery";
import { dnaReport, shiftReport } from "@app/spotify/lib/reports/insight";
import { summaryReport } from "@app/spotify/lib/reports/summary";
import {
    calendarReport,
    clockReport,
    seasonsReport,
    type TimelineOpts,
    timelineReport,
} from "@app/spotify/lib/reports/time";
import { type TopOpts, type TopReport, topReport } from "@app/spotify/lib/reports/top";
import { wrappedReport } from "@app/spotify/lib/reports/wrapped";
import { renderBehavior, renderSessions, renderSkips, renderStreaks } from "@app/spotify/render/behavior";
import { renderArtist, renderSearch, renderTrack } from "@app/spotify/render/deepdive";
import {
    renderDiscovery,
    renderFirsts,
    renderForgotten,
    renderLoyalty,
    renderObsessions,
} from "@app/spotify/render/discovery";
import { renderDna, renderShift } from "@app/spotify/render/insight";
import { renderSummary } from "@app/spotify/render/summary";
import { renderCalendar, renderClock, renderSeasons, renderTimeline } from "@app/spotify/render/time";
import { renderTop } from "@app/spotify/render/top";
import { renderWrapped } from "@app/spotify/render/wrapped";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * `--csv` always writes the FULL ranking, not the visible slice. The confirmation goes to
 * stderr so `--json --csv` leaves a parseable payload on stdout.
 */
async function writeTopCsv(report: TopReport, path: string): Promise<void> {
    const rows =
        report.kind === "genres"
            ? {
                  headers: ["rank", "genre", "plays", "hours", "share", "tracks", "artists"],
                  values: report.genres.map((g, i) => [i + 1, g.genre, g.plays, g.hours, g.share, g.tracks, g.artists]),
                  count: report.genres.length,
              }
            : {
                  headers: ["rank", "name", "artist", "plays", "shortPlays", "hours", "releases", "first", "last"],
                  values: report.rows.map((r, i) => [
                      i + 1,
                      r.name,
                      r.artist,
                      r.plays,
                      r.shortPlays,
                      r.hours,
                      r.releases,
                      r.first.slice(0, 10),
                      r.last.slice(0, 10),
                  ]),
                  count: report.rows.length,
              };

    await Bun.write(path, toCsv(rows.headers, rows.values));
    out.printlnErr(pc.gray(`\n  full ranking (${rows.count} rows) written to ${path}`));
}

export function registerAnalytics(program: Command): void {
    common(
        program
            .command("summary")
            .alias("stats")
            .description("lifetime overview: hours, per-year shape, concentration, streaks")
    ).action((o: CommonOpts) => {
        emit(o.json, summaryReport(o), renderSummary);
    });

    common(
        program
            .command("top [what]")
            .description("ranked tracks | songs | artists | albums | genres by how much you actually played them")
            .option("--by <metric>", "plays or hours", "plays")
            .option("--min <n>", "drop rows below this many plays", "1")
            .option("--csv <path>", "write the FULL ranking to a CSV file")
            .option("--no-trend", "skip the trend sparkline column")
    ).action(async (what: string | undefined, o: TopOpts & { csv?: string }) => {
        const report = topReport({ ...o, kind: what });
        emit(o.json, report, renderTop);
        if (o.csv) {
            await writeTopCsv(report, o.csv);
        }
    });

    common(
        program
            .command("timeline")
            .description("plays over time, bucketed and drawn")
            .option("-b, --bucket <size>", "day | week | month | quarter | year (default: fits the window)")
            .option("--by <metric>", "plays or hours", "plays")
    ).action((o: TimelineOpts) => {
        emit(o.json, timelineReport(o), renderTimeline);
    });

    common(program.command("clock").description("the weekly heatmap: which hours of which days you listen")).action(
        (o: CommonOpts) => {
            emit(o.json, clockReport(o), renderClock);
        }
    );

    common(program.command("calendar").description("a year as a day grid, one cell per day")).action(
        (o: CommonOpts) => {
            emit(o.json, calendarReport(o), renderCalendar);
        }
    );

    common(
        program
            .command("seasons")
            .description("month-of-year rhythm across all years, and what each season sounds like")
    ).action((o: CommonOpts) => {
        emit(o.json, seasonsReport(o), renderSeasons);
    });

    common(
        program
            .command("behavior")
            .alias("habits")
            .description("devices, shuffle, offline, private sessions, how tracks start and end")
    ).action((o: CommonOpts) => {
        emit(o.json, behaviorReport(o), renderBehavior);
    });

    common(
        program
            .command("skips")
            .description("what you bail out of — artists and tracks you start but do not finish")
            .option("--min <n>", "only rows with at least this many starts", "12")
    ).action((o: CommonOpts & { min?: string }) => {
        emit(o.json, skipsReport(o), (r) => renderSkips(r, limitOf(o)));
    });

    common(
        program
            .command("sessions")
            .description("listening sittings: how long, how often, and the biggest ones")
            .option("--gap <minutes>", "silence that ends a sitting", "30")
    ).action((o: CommonOpts & { gap?: string }) => {
        emit(o.json, sessionsReport(o), (r) => renderSessions(r, limitOf(o)));
    });

    common(program.command("streaks").description("consecutive listening days, and the silences between them")).action(
        (o: CommonOpts) => {
            emit(o.json, streaksReport(o), (r) => renderStreaks(r, limitOf(o)));
        }
    );

    common(
        program.command("discovery").description("how much of each year was music you had never heard before")
    ).action((o: CommonOpts) => {
        emit(o.json, discoveryReport(o), renderDiscovery);
    });

    common(
        program
            .command("firsts")
            .description("the day each of your biggest artists entered your life")
            .option("--min <n>", "only artists with at least this many plays", "60")
    ).action((o: CommonOpts & { min?: string }) => {
        emit(o.json, firstsReport(o), renderFirsts);
    });

    common(
        program
            .command("forgotten")
            .description("tracks you wore out once and have not touched since")
            .option("--min <n>", "at least this many plays historically", "15")
            .option("--quiet-months <n>", "silent for at least this many months", "18")
    ).action((o: CommonOpts & { min?: string; quietMonths?: string }) => {
        emit(o.json, forgottenReport(o), (r) => renderForgotten(r, limitOf(o)));
    });

    common(
        program
            .command("obsessions")
            .description("the song of each month: what you binged hardest, when")
            .option("--window <days>", "how wide an obsession window is", "30")
            .option("--min <n>", "ignore tracks under this many plays", "6")
    ).action((o: CommonOpts & { window?: string; min?: string }) => {
        emit(o.json, obsessionsReport(o), (r) => renderObsessions(r, limitOf(o)));
    });

    common(
        program
            .command("loyalty")
            .description("ride-or-die artists versus phases you grew out of")
            .option("--min <n>", "only artists with at least this many plays", "40")
    ).action((o: CommonOpts & { min?: string }) => {
        emit(o.json, loyaltyReport(o), (r) => renderLoyalty(r, limitOf(o)));
    });

    common(
        program
            .command("dna")
            .alias("fingerprint")
            .description("a taste fingerprint on eight axes: diversity, novelty, obscurity, loyalty and more")
    ).action((o: CommonOpts) => {
        emit(o.json, dnaReport(o), renderDna);
    });

    common(
        program
            .command("shift <from> <to>")
            .description("how far your taste moved between two periods (years, or YYYY-MM-DD ranges)")
            .option("--min <n>", "artists need this many plays in a period to be listed", "10")
    ).action((from: string, to: string, o: CommonOpts & { min?: string }) => {
        emit(o.json, shiftReport(from, to, o), (r) => renderShift(r, limitOf(o, 12)));
    });

    common(
        program
            .command("artist <query>")
            .description("everything about one artist: arc, top tracks, peak, share of your life")
    ).action((query: string, o: CommonOpts) => {
        emit(o.json, artistReport(query, o), (r) => renderArtist(r, limitOf(o)));
    });

    common(
        program
            .command("track <query>")
            .description("one song's whole history: when it landed, when it peaked, when it faded")
    ).action((query: string, o: CommonOpts) => {
        emit(o.json, trackReport(query, o), renderTrack);
    });

    common(
        program.command("search <query>").description("find anything you have ever played, by title or artist")
    ).action((query: string, o: CommonOpts) => {
        emit(o.json, searchReport(query, o), (r) => renderSearch(r, limitOf(o)));
    });

    common(
        program.command("wrapped [year]").description("your own Wrapped for any year on record, computed offline")
    ).action((year: string | undefined, o: CommonOpts) => {
        emit(o.json, wrappedReport(year, o), renderWrapped);
    });
}
