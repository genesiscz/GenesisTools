/**
 * Typed client for `/api/report/:name`.
 *
 * Every payload type is imported straight from `lib/reports/*` with `import type`, so the
 * browser bundle carries none of the server code and the two can never drift: change a
 * report's shape and this file stops compiling.
 */
import type { ReportRequest } from "@app/spotify/lib/reports";
import type { BehaviorReport, SessionsReport, SkipsReport, StreaksReport } from "@app/spotify/lib/reports/behavior";
import type { BlendReport, CompatReport, CompatTimelineReport, GiftReport } from "@app/spotify/lib/reports/compat";
import type { ArtistReport, SearchReport, TrackReport } from "@app/spotify/lib/reports/deepdive";
import type {
    DiscoveryReport,
    FirstsReport,
    ForgottenReport,
    LoyaltyReport,
    ObsessionsReport,
} from "@app/spotify/lib/reports/discovery";
import type { DnaReport, ShiftReport } from "@app/spotify/lib/reports/insight";
import type { AuditReport, GemsReport, MainstreamReport, SavesReport } from "@app/spotify/lib/reports/library";
import type { DoctorReport } from "@app/spotify/lib/reports/pipeline";
import type { ProfileListReport } from "@app/spotify/lib/reports/profiles";
import type { SummaryReport } from "@app/spotify/lib/reports/summary";
import type { CalendarReport, ClockReport, SeasonsReport, TimelineReport } from "@app/spotify/lib/reports/time";
import type { TopReport } from "@app/spotify/lib/reports/top";
import type { WrappedReport } from "@app/spotify/lib/reports/wrapped";
import { SafeJSON } from "@genesiscz/utils/json";
import { useQuery } from "@tanstack/react-query";

/** Report name → the payload it returns. */
export interface ReportMap {
    summary: SummaryReport;
    top: TopReport;
    timeline: TimelineReport;
    clock: ClockReport;
    calendar: CalendarReport;
    seasons: SeasonsReport;
    behavior: BehaviorReport;
    skips: SkipsReport;
    sessions: SessionsReport;
    streaks: StreaksReport;
    discovery: DiscoveryReport;
    firsts: FirstsReport;
    forgotten: ForgottenReport;
    obsessions: ObsessionsReport;
    loyalty: LoyaltyReport;
    audit: AuditReport;
    gems: GemsReport;
    mainstream: MainstreamReport;
    saves: SavesReport;
    dna: DnaReport;
    shift: ShiftReport;
    artist: ArtistReport;
    track: TrackReport;
    search: SearchReport;
    wrapped: WrappedReport;
    compat: CompatReport;
    compatTimeline: CompatTimelineReport;
    blend: BlendReport;
    gift: GiftReport;
    doctor: DoctorReport;
}

export type ReportKey = keyof ReportMap;

export type ReportParams = Partial<Record<keyof ReportRequest, string | number | boolean | undefined>>;

function toSearch(params: ReportParams): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") {
            continue;
        }

        search.set(key, String(value));
    }

    const s = search.toString();

    return s ? `?${s}` : "";
}

async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;

        throw new Error(body?.error ?? `HTTP ${res.status}`);
    }

    return (await res.json()) as T;
}

export async function fetchReport<K extends ReportKey>(
    name: K,
    params: ReportParams = {},
    signal?: AbortSignal
): Promise<ReportMap[K]> {
    return readJson<ReportMap[K]>(await fetch(`/api/report/${name}${toSearch(params)}`, { signal }));
}

/**
 * `enabled: false` keeps a report from firing before its required argument exists (an empty
 * search box, a compat page with only one profile picked). The query's own `AbortSignal` is
 * forwarded, so switching filter or tab cancels the superseded request instead of leaving a
 * full ranking in flight.
 */
export function useReport<K extends ReportKey>(
    name: K,
    params: ReportParams = {},
    options: { enabled?: boolean } = {}
) {
    return useQuery<ReportMap[K], Error>({
        queryKey: ["report", name, params],
        queryFn: ({ signal }) => fetchReport(name, params, signal),
        enabled: options.enabled ?? true,
    });
}

export async function fetchProfiles(): Promise<ProfileListReport> {
    return readJson<ProfileListReport>(await fetch("/api/profiles"));
}

export interface ProfileWrite {
    action?: "add" | "use" | "remove";
    name: string;
    history?: string;
    data?: string;
    label?: string;
    tz?: string;
}

export async function writeProfile(body: ProfileWrite): Promise<ProfileListReport> {
    return readJson<ProfileListReport>(
        await fetch("/api/profiles", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: SafeJSON.stringify(body),
        })
    );
}
