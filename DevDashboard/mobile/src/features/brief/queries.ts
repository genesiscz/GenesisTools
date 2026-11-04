import { type BriefResetDto, type DashboardClient, ENDPOINTS, type MorningBriefDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const briefKeys = { latest: ["brief", "latest"] as const };

/** The Mac builds the brief once a day, so the screen refetches only on focus and pull. */
export function briefQuery(client: DashboardClient) {
    return queryOptions<MorningBriefDto | null>({
        queryKey: briefKeys.latest,
        queryFn: () => client.call(ENDPOINTS.gatewayBrief, {}),
        staleTime: 5 * 60_000,
    });
}

function clock(iso: string): string {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "Leave 07:15, 35 min, arrive 07:50", or why Waze gave no answer. */
export function commuteLine(brief: MorningBriefDto): string | null {
    const commute = brief.commute;

    if (!commute) {
        return null;
    }

    if (commute.error || !commute.leaveAt || !commute.arriveAt) {
        return commute.error ?? "No departure in the window";
    }

    return `Leave ${clock(commute.leaveAt)}, ${commute.minutes} min, arrive ${clock(commute.arriveAt)}`;
}

/** "82 %, resets 07:00", or "12 %" when the reading has no reset time. */
export function resetLine(reset: BriefResetDto): string {
    return reset.resetsAt ? `${reset.utilization} %, resets ${clock(reset.resetsAt)}` : `${reset.utilization} %`;
}

/** "3 sessions, 7 commits, 2 decisions answered". */
export function overnightLine(brief: MorningBriefDto): string | null {
    const night = brief.overnight;
    return night
        ? `${night.sessions} sessions, ${night.commits} commits, ${night.decisionsAnswered} decisions answered`
        : null;
}

/** True when the stored brief is not from today (the daemon task did not run, or the Mac slept through it). */
export function isStale(brief: MorningBriefDto, now: Date): boolean {
    return new Date(brief.generatedAt).toDateString() !== now.toDateString();
}
