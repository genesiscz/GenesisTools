/**
 * The morning brief (F29): one card for the start of the day. Types only (`contract-purity.test.ts`). The Mac builds
 * it once a day (the `hub-morning-brief` daemon task runs `tools hub brief --refresh`, one Waze call) and stores it;
 * the phone reads the stored brief (`/api/gateway/brief`) and gets one push when it is new.
 */

export interface BriefCommuteDto {
    from: string;
    to: string;
    /** The best departure in the window Waze compared; null when the call failed. */
    leaveAt: string | null;
    arriveAt: string | null;
    minutes: number | null;
    error: string | null;
}

export interface BriefWeatherDto {
    label: string;
    tempC: number | null;
    description: string;
    error: string | null;
}

export interface BriefOvernightDto {
    since: string;
    sessions: number;
    commits: number;
    decisionsAnswered: number;
    /** Titles of the sessions that worked overnight, newest first, at most five. */
    titles: string[];
}

export interface BriefResetDto {
    provider: string;
    account: string;
    label: string;
    utilization: number;
    resetsAt: string | null;
}

export interface MorningBriefDto {
    generatedAt: string;
    commute: BriefCommuteDto | null;
    weather: BriefWeatherDto | null;
    overnight: BriefOvernightDto | null;
    decisionsWaiting: number | null;
    /** Each account's short window and when it resets. */
    resets: BriefResetDto[];
    /** What could not be read, one line per part. */
    warnings: string[];
}
