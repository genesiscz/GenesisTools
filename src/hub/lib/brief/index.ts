import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
    BriefCommuteDto,
    BriefOvernightDto,
    BriefResetDto,
    BriefWeatherDto,
    MorningBriefDto,
} from "@app/dev-dashboard/contract/brief";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { execTool, toolCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { Storage } from "@genesiscz/utils/storage";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/**
 * The morning brief (F29). The `hub-morning-brief` daemon task runs `tools hub brief --refresh --push` once a day: it
 * asks Waze ONE departure question (Waze blocks an IP after about 200 requests, so nothing here retries or polls),
 * reads the weather, the overnight digest, the waiting decisions and the cached AI usage readings, stores the result
 * and sends one push. The phone and `tools hub brief` only read the stored file.
 */

const log = logger.child({ component: "hub:brief" });

/** The hub config key (`~/.genesis-tools/hub/config.json`). Nested by part, so a new part adds its own object. */
export const BRIEF_CONFIG_KEY = "brief";

export const BRIEF_TASK_NAME = "hub-morning-brief";

export interface BriefConfig {
    schedule: {
        /** Local "HH:MM" the daemon task builds the brief at. */
        at: string;
    };
    /** Null until a trip is set: the brief then asks Waze nothing. */
    commute: {
        from: string;
        to: string;
        /** Earliest departure, local "HH:MM". */
        leaveAfter: string;
        /** How many hours of departures Waze compares. */
        windowHours: number;
    } | null;
    overnight: {
        /** Local "HH:MM" of the previous day the overnight window starts at. */
        since: string;
    };
}

export const DEFAULT_BRIEF_CONFIG: BriefConfig = {
    schedule: { at: "06:00" },
    commute: null,
    overnight: { since: "18:00" },
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The stored config merged over the defaults; a malformed part falls back to its default and is logged. */
export function parseBriefConfig(raw: unknown): BriefConfig {
    const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const schedule = value.schedule as { at?: unknown } | undefined;
    const overnight = value.overnight as { since?: unknown } | undefined;
    const commute = value.commute as Record<string, unknown> | null | undefined;
    const clock = (text: unknown, fallback: string): string =>
        typeof text === "string" && CLOCK.test(text) ? text : fallback;
    let trip: BriefConfig["commute"] = null;

    if (commute && typeof commute.from === "string" && typeof commute.to === "string" && commute.from && commute.to) {
        const hours = Number(commute.windowHours);
        trip = {
            from: commute.from,
            to: commute.to,
            leaveAfter: clock(commute.leaveAfter, "07:00"),
            windowHours: Number.isFinite(hours) && hours >= 0.5 && hours <= 24 ? hours : 2,
        };
    } else if (commute) {
        log.warn({ commute }, "brief: the commute needs from and to; the brief asks Waze nothing");
    }

    return {
        schedule: { at: clock(schedule?.at, DEFAULT_BRIEF_CONFIG.schedule.at) },
        commute: trip,
        overnight: { since: clock(overnight?.since, DEFAULT_BRIEF_CONFIG.overnight.since) },
    };
}

export async function readBriefConfig(storage = new Storage("hub")): Promise<BriefConfig> {
    return parseBriefConfig(await storage.getConfigValue<unknown>(BRIEF_CONFIG_KEY));
}

export async function writeBriefConfig(config: BriefConfig, storage = new Storage("hub")): Promise<BriefConfig> {
    const parsed = parseBriefConfig(config);
    await storage.setConfigValue(BRIEF_CONFIG_KEY, parsed);
    return parsed;
}

export function briefPath(): string {
    return join(toolDataDir("hub", "brief"), "latest.json");
}

/** The stored brief, or null before the first build. */
export function readBrief(path = briefPath()): MorningBriefDto | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8")) as MorningBriefDto;
    } catch (error) {
        log.warn({ error, path }, "brief: the stored brief could not be read");
        return null;
    }
}

/** The parts the brief reads; tests pass fakes, so no Waze call, no network and no history scan runs. */
export interface BriefDeps {
    commute(trip: NonNullable<BriefConfig["commute"]>): Promise<BriefCommuteDto>;
    weather(): Promise<BriefWeatherDto>;
    overnight(since: Date, until: Date): Promise<BriefOvernightDto>;
    decisionsWaiting(): Promise<number>;
    snapshots(): Promise<AccountUsageSnapshot[]>;
}

/** `tools waze --json depart`: one call, the best departure only. */
async function wazeCommute(trip: NonNullable<BriefConfig["commute"]>): Promise<BriefCommuteDto> {
    const base = { from: trip.from, to: trip.to };
    const result = await execTool(
        ["waze", "--json", "depart", trip.from, trip.to, "--at", trip.leaveAfter, "--window", String(trip.windowHours)],
        { timeout: 120_000 }
    );

    if (result.exitCode !== 0) {
        const error = result.stderr.trim().split("\n").at(-1) || `waze depart exited ${result.exitCode}`;
        return { ...base, leaveAt: null, arriveAt: null, minutes: null, error };
    }

    const data = SafeJSON.parse(result.stdout) as { best?: { leaveAt: number; arriveAt: number; minutes: number } };

    if (!data.best) {
        return { ...base, leaveAt: null, arriveAt: null, minutes: null, error: "no departure in that window" };
    }

    return {
        ...base,
        leaveAt: new Date(data.best.leaveAt).toISOString(),
        arriveAt: new Date(data.best.arriveAt).toISOString(),
        minutes: data.best.minutes,
        error: null,
    };
}

async function liveWeather(): Promise<BriefWeatherDto> {
    const { getConfig } = await import("@app/dev-dashboard/config");
    const { fetchWeather } = await import("@app/dev-dashboard/lib/weather/client");
    const snapshot = await fetchWeather((await getConfig()).weatherCoords);
    return {
        label: snapshot.label,
        tempC: snapshot.tempC,
        description: snapshot.description,
        error: snapshot.error ?? null,
    };
}

async function liveOvernight(since: Date, until: Date): Promise<BriefOvernightDto> {
    const { buildDigest } = await import("../digest");
    const digest = await buildDigest({ window: { since, until }, prs: false });
    return {
        since: since.toISOString(),
        sessions: digest.sessions.length,
        commits: digest.commits.length,
        decisionsAnswered: digest.decisions.answered.length,
        titles: [...digest.sessions]
            .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
            .slice(0, 5)
            .map((session) => session.title),
    };
}

async function liveDecisionsWaiting(): Promise<number> {
    const { loadWaitingQueue } = await import("@app/question/lib/inbox/load");
    return (await loadWaitingQueue()).total;
}

async function cachedSnapshots(): Promise<AccountUsageSnapshot[]> {
    // The poller's cache only: the brief fetches no account, so no refresh token is spent.
    const cache = await readSnapshotsCache();
    return Object.values(cache?.providers ?? {}).flatMap((slice) => slice.accounts);
}

export const realBriefDeps: BriefDeps = {
    commute: wazeCommute,
    weather: liveWeather,
    overnight: liveOvernight,
    decisionsWaiting: liveDecisionsWaiting,
    snapshots: cachedSnapshots,
};

/** The overnight window: from `since` ("HH:MM") of the day before `now`, until `now`. */
export function overnightWindow(since: string, now: Date): { since: Date; until: Date } {
    const [hours, minutes] = since.split(":").map(Number);
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(hours, minutes, 0, 0);
    return { since: start, until: now };
}

/** Each account's short (session) window: how full it is and when it resets, soonest reset first. */
export function briefResets(snapshots: readonly AccountUsageSnapshot[]): BriefResetDto[] {
    return snapshots
        .flatMap((snapshot) =>
            snapshot.limits
                .filter((limit) => limit.kind === "session")
                .map((limit) => ({
                    provider: snapshot.provider,
                    account: snapshot.label ?? snapshot.accountName,
                    label: limit.label,
                    utilization: Math.round(limit.percentUsed),
                    resetsAt: limit.resetsAt ?? null,
                }))
        )
        .sort((a, b) => (a.resetsAt ?? "￿").localeCompare(b.resetsAt ?? "￿"));
}

/** Runs one part; a failure becomes a warning line and a null part, so one broken source never hides the rest. */
async function part<T>(name: string, warnings: string[], run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ error, part: name }, "brief: a part could not be read");
        warnings.push(`${name}: ${message}`);
        return null;
    }
}

export async function buildBrief({
    config,
    deps = realBriefDeps,
    now = new Date(),
}: {
    config: BriefConfig;
    deps?: BriefDeps;
    now?: Date;
}): Promise<MorningBriefDto> {
    const warnings: string[] = [];
    const window = overnightWindow(config.overnight.since, now);
    const trip = config.commute;
    const [commute, weather, overnight, decisionsWaiting, snapshots] = await Promise.all([
        trip ? part("commute", warnings, () => deps.commute(trip)) : Promise.resolve(null),
        part("weather", warnings, () => deps.weather()),
        part("overnight", warnings, () => deps.overnight(window.since, window.until)),
        part("decisions", warnings, () => deps.decisionsWaiting()),
        part("resets", warnings, () => deps.snapshots()),
    ]);

    if (!trip) {
        warnings.push(`commute: no trip set (${toolCommand("hub brief config")} --from <place> --to <place>)`);
    }

    return {
        generatedAt: now.toISOString(),
        commute,
        weather,
        overnight,
        decisionsWaiting,
        resets: briefResets(snapshots ?? []),
        warnings,
    };
}

export function storeBrief(brief: MorningBriefDto, path = briefPath()): string {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, SafeJSON.stringify(brief, null, 2));
    return path;
}

function clockOf(iso: string | null): string | null {
    return iso
        ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
        : null;
}

/** The push text: the departure first, then the weather and what waits. */
export function briefNoticeLines(brief: MorningBriefDto): { title: string; message: string } {
    const leave = clockOf(brief.commute?.leaveAt ?? null);
    const title = leave
        ? `Leave at ${leave} for ${brief.commute?.to} (${brief.commute?.minutes} min)`
        : "Morning brief";
    const parts: string[] = [];

    if (brief.weather && brief.weather.tempC !== null) {
        parts.push(`${Math.round(brief.weather.tempC)} °C, ${brief.weather.description}`);
    }

    if (brief.decisionsWaiting) {
        parts.push(`${brief.decisionsWaiting} decisions wait`);
    }

    if (brief.overnight) {
        parts.push(`${brief.overnight.sessions} sessions and ${brief.overnight.commits} commits overnight`);
    }

    return { title, message: parts.join(" · ") || "Open the app for the brief" };
}

/** One push to the phone only: the Mac banner would repeat what the Mac already shows. */
export async function pushBrief(brief: MorningBriefDto): Promise<boolean> {
    const { title, message } = briefNoticeLines(brief);
    return dispatchNotification({
        app: "hub",
        title,
        message,
        id: `brief-${brief.generatedAt.slice(0, 10)}`,
        group: "hub-morning-brief",
        only: ["phone"],
    });
}
