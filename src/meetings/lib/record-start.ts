import { spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { calendarAround } from "@genesiscz/utils/meetings/calendar";
import { DISPLAY_POLICIES, type DisplayPolicy, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { AUDIO_SOURCES, type AudioSource } from "@genesiscz/utils/screen-recorder/control";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { ensureScreenRecording } from "./grants";
import { linkSource } from "./link";
import { resolveProject } from "./project";
import { readRecorderState, recorderAcknowledged } from "./recorder-shared";
import { errorText, TOOL } from "./shared";
import { sourceRefOf } from "./sources";
import { deliverStartFailures } from "./start-failures";
import { ensureWatcher, shouldStartWatcherForRecording } from "./watcher";

const { log } = logger.scoped("meetings-record-start");
/** `mic,system` as audio sources; undefined when a part is none of them. */
export function parseAudioSources(raw: string): AudioSource[] | undefined {
    const parts = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    return parts.every((part): part is AudioSource => (AUDIO_SOURCES as readonly string[]).includes(part))
        ? [...new Set(parts)]
        : undefined;
}

export function parseDisplayPolicy(raw: string): DisplayPolicy | undefined {
    if ((DISPLAY_POLICIES as readonly string[]).includes(raw)) {
        return raw as DisplayPolicy;
    }

    const index = Number(raw);
    return /^\d+$/.test(raw) && Number.isInteger(index) ? index : undefined;
}
const WAIT_STEP_MS = 500;

export async function waitForRecorder(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (check()) {
            return true;
        }

        await Bun.sleep(Math.min(WAIT_STEP_MS, deadline - Date.now()));
    }

    return check();
}

/** The meeting to record: named, built from a source, or new (with the calendar event around now). */
async function meetingToRecord(
    store: MeetingStore,
    opts: { meeting?: string; source?: string; title?: string; project?: string; yes?: boolean }
): Promise<MeetingRecord> {
    const config = new MeetingsConfigStore();

    if (opts.meeting) {
        const record = store.resolve(opts.meeting);

        if (!record) {
            throw new Error(`No meeting "${opts.meeting}" (${TOOL} list)`);
        }

        return record;
    }

    if (opts.source) {
        const { record } = await linkSource({
            store,
            config,
            sourceRef: opts.source,
            project: opts.project,
            command: "record start",
            createdBy: "record",
            quiet: opts.yes,
        });
        return record;
    }

    const now = new Date();
    const calendar = await calendarAround(now);
    const title = opts.title ?? calendar?.title ?? `Meeting ${localTime(now.toISOString()).slice(11)}`;
    const { project } = await resolveProject({
        config,
        flag: opts.project,
        facts: { title, calendar: calendar?.calendar },
        quiet: opts.yes,
    });

    return store.create(
        {
            title,
            start: now.toISOString(),
            createdBy: "record",
            ...(project ? { project } : {}),
            ...(calendar ? { calendar } : {}),
        },
        {
            command: "record start",
            change: `created "${title}"${calendar ? ` from calendar ${calendar.calendar ?? ""}` : ""}`,
        }
    );
}

export interface StartOptions {
    meeting?: string;
    source?: string;
    title?: string;
    project?: string;
    display?: string;
    audio?: string;
    yes?: boolean;
    /** The watcher owns failure reporting when it spawns this command. */
    fromWatcher?: boolean;
}

export async function startMeetingRecording(opts: StartOptions, store = new MeetingStore()) {
    const current = readRecorderState(store);
    const audio = opts.audio === undefined ? [] : parseAudioSources(opts.audio);
    if (audio === undefined) {
        throw new Error(`--audio ${opts.audio} is not a list of ${AUDIO_SOURCES.join(", ")} (for example mic,system).`);
    }
    if (current.running) {
        throw new Error(
            `Already recording ${current.state?.meetingId ?? "a meeting"}. Stop it first: ${TOOL} record stop`
        );
    }
    const display = opts.display === undefined ? undefined : parseDisplayPolicy(opts.display);
    if (opts.display !== undefined && display === undefined) {
        throw new Error(
            `--display ${opts.display} is none of ${DISPLAY_POLICIES.join(", ")} or a screen index (0, 1, 2 …).`
        );
    }
    const {
        global: { capture },
    } = await new MeetingsConfigStore(store.storage).read();
    const fallbackSources = opts.audio === undefined ? capture.recorders.native.audio.sources : audio;
    const canKeepSound = capture.soundWithoutScreen && fallbackSources.length > 0;
    const record = await meetingToRecord(store, opts);
    const source = sourceRefOf(record);
    const key = source ? `${source.sourceId}:${source.sourceMeetingId}` : record.id;
    const report = async (problem: string, partial: boolean) => {
        if (!opts.fromWatcher) {
            await deliverStartFailures(store, { key, meeting: record.title || record.id, problem, partial }).catch(
                (err: unknown) =>
                    log.error({ err, meeting: record.id, problem }, "could not persist the recording start alert")
            );
        }
    };
    let identity: string;
    let partial: string | undefined;
    let withoutScreen = false;
    try {
        const grant = await ensureScreenRecording({ quiet: opts.yes, allowSoundOnly: canKeepSound });
        identity = grant.identity;
        withoutScreen = !grant.granted;
        if (withoutScreen && !canKeepSound) {
            throw new Error(grant.message ?? `Screen Recording is not granted to ${identity}.`);
        }
        const startedAfter = Date.now();
        const pid = spawnToolDetached([
            "meetings",
            "record",
            "run",
            record.id,
            ...(withoutScreen ? ["--without-screen", grant.message ?? "Screen Recording is unavailable"] : []),
            ...(display !== undefined ? ["--display", String(display)] : []),
            ...(audio.length > 0 ? ["--audio", audio.join(",")] : []),
        ]);
        log.info({ meeting: record.id, pid, identity }, "recorder started");
        const waitMs = withoutScreen ? 60_000 : 15_000;
        const reported = await waitForRecorder(() => {
            if (recorderAcknowledged({ current: readRecorderState(store), meetingId: record.id, startedAfter })) {
                return true;
            }
            const saved = store.read(record.id)?.recording;
            if (
                saved?.stoppedAt &&
                Date.parse(saved.stoppedAt) >= startedAfter &&
                (saved.stopReason === "error" || saved.stopReason === "failed")
            ) {
                throw new Error(saved.warning ?? "The recorder stopped during startup.");
            }
            return false;
        }, waitMs);
        if (!reported) {
            throw new Error(`The recorder did not report within ${waitMs / 1000} s.`);
        }
        const active = readRecorderState(store).state;
        if (withoutScreen) {
            partial = active?.warning ?? grant.message ?? "Screen frames omitted.";
        } else if (grant.microphone === false && capture.backend === "native" && fallbackSources.includes("mic")) {
            partial = "Microphone access is not granted. Its track is unavailable.";
        }
    } catch (err) {
        await report(errorText(err), false);
        throw err;
    }
    if (partial) {
        await report(partial, true);
    }
    let watcherOff = false;
    try {
        if (await shouldStartWatcherForRecording()) {
            await ensureWatcher();
        } else {
            watcherOff = true;
        }
    } catch (err) {
        log.warn({ err, meeting: record.id }, "recording started, but its recovery watcher did not start");
    }
    return { meeting: record.id, project: record.project, identity, withoutScreen, partial, watcherOff };
}
