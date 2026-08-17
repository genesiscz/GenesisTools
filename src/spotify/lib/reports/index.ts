/**
 * One name per report, so the HTTP door is a single thin dispatcher instead of thirty
 * near-identical route files. The CLI reaches the same functions directly.
 *
 * Reports that take positional arguments on the CLI (`artist <query>`, `shift <from> <to>`,
 * `compat <a> <b>`, `wrapped [year]`) read them off the same request object here.
 */
import type { CommonOpts } from "@app/spotify/lib/context";
import { behaviorReport, sessionsReport, skipsReport, streaksReport } from "@app/spotify/lib/reports/behavior";
import { blendReport, compatReport, compatTimelineReport, giftReport } from "@app/spotify/lib/reports/compat";
import { artistReport, searchReport, trackReport } from "@app/spotify/lib/reports/deepdive";
import {
    discoveryReport,
    firstsReport,
    forgottenReport,
    loyaltyReport,
    obsessionsReport,
} from "@app/spotify/lib/reports/discovery";
import { dnaReport, shiftReport } from "@app/spotify/lib/reports/insight";
import { auditReport, gemsReport, mainstreamReport, savesReport } from "@app/spotify/lib/reports/library";
import { doctorReport, exportReport, parseExportKind } from "@app/spotify/lib/reports/pipeline";
import { summaryReport } from "@app/spotify/lib/reports/summary";
import { calendarReport, clockReport, seasonsReport, timelineReport } from "@app/spotify/lib/reports/time";
import { topReport } from "@app/spotify/lib/reports/top";
import { wrappedReport } from "@app/spotify/lib/reports/wrapped";

export interface ReportRequest extends CommonOpts {
    /** `top` / `export`: what to rank or write. */
    kind?: string;
    by?: string;
    min?: string;
    maxGlobal?: string;
    bucket?: string;
    gap?: string;
    window?: string;
    quietMonths?: string;
    minPlays?: string;
    trend?: boolean;
    /** `artist` / `track` / `search`. */
    q?: string;
    /** `shift`. */
    from?: string;
    /** `shift`, and the year for `wrapped`. */
    to?: string;
    year?: string;
    /** `compat` / `blend` / `gift`. */
    a?: string;
    b?: string;
    timeline?: boolean;
}

function requireArg(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`missing required "${name}"`);
    }

    return value;
}

export const REPORTS = {
    summary: (o: ReportRequest) => summaryReport(o),
    top: (o: ReportRequest) => topReport(o),
    timeline: (o: ReportRequest) => timelineReport(o),
    clock: (o: ReportRequest) => clockReport(o),
    calendar: (o: ReportRequest) => calendarReport(o),
    seasons: (o: ReportRequest) => seasonsReport(o),
    behavior: (o: ReportRequest) => behaviorReport(o),
    skips: (o: ReportRequest) => skipsReport(o),
    sessions: (o: ReportRequest) => sessionsReport(o),
    streaks: (o: ReportRequest) => streaksReport(o),
    discovery: (o: ReportRequest) => discoveryReport(o),
    firsts: (o: ReportRequest) => firstsReport(o),
    forgotten: (o: ReportRequest) => forgottenReport(o),
    obsessions: (o: ReportRequest) => obsessionsReport(o),
    loyalty: (o: ReportRequest) => loyaltyReport(o),
    audit: (o: ReportRequest) => auditReport(o),
    gems: (o: ReportRequest) => gemsReport(o),
    mainstream: (o: ReportRequest) => mainstreamReport(o),
    saves: (o: ReportRequest) => savesReport(o),
    dna: (o: ReportRequest) => dnaReport(o),
    shift: (o: ReportRequest) => shiftReport(requireArg(o.from, "from"), requireArg(o.to, "to"), o),
    artist: (o: ReportRequest) => artistReport(requireArg(o.q, "q"), o),
    track: (o: ReportRequest) => trackReport(requireArg(o.q, "q"), o),
    search: (o: ReportRequest) => searchReport(requireArg(o.q, "q"), o),
    wrapped: (o: ReportRequest) => wrappedReport(o.year, o),
    compat: (o: ReportRequest) => compatReport(requireArg(o.a, "a"), requireArg(o.b, "b"), o),
    compatTimeline: (o: ReportRequest) => compatTimelineReport(requireArg(o.a, "a"), requireArg(o.b, "b"), o),
    blend: (o: ReportRequest) => blendReport(requireArg(o.a, "a"), requireArg(o.b, "b"), o),
    gift: (o: ReportRequest) => giftReport(requireArg(o.a, "a"), requireArg(o.b, "b"), o),
    export: (o: ReportRequest) => exportReport(parseExportKind(o.kind), o),
    doctor: () => doctorReport(),
} as const;

export type ReportName = keyof typeof REPORTS;

/**
 * `in` walks the prototype chain, so it would accept `toString` and `constructor` and hand
 * `Object.prototype.toString` to the HTTP route as if it were a report.
 */
export function isReportName(name: string): name is ReportName {
    return Object.hasOwn(REPORTS, name);
}

export function runReport(name: ReportName, request: ReportRequest): unknown {
    return REPORTS[name](request);
}
