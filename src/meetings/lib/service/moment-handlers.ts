import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { cutTone, probeAudio } from "../audio";
import { clipMoment, MomentError, openMoment } from "../moment";
import type { MomentStateCode } from "../moment-schema";
import { OpenedMeeting } from "../opened-meeting";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsCallContext, type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's Moment methods (`moment.plan`, `moment.clip`, `tone.preview`, `meeting.audio`): the Moment
 * engine behind the service. Loaded by handlers.ts only when a call plays.
 */

const { log } = logger.scoped("meetings-service");

function openedOf(store: MeetingStore, record: MeetingRecord, deps: MeetingsHandlerDeps): OpenedMeeting {
    return OpenedMeeting.of(store, record, deps.linkedSource?.(record));
}

/** Why a Moment cannot play now, or nothing: the recording is not final, ffmpeg is missing, no source keeps the audio. */
async function cannotPlay(
    record: MeetingRecord,
    opened: OpenedMeeting,
    deps: MeetingsHandlerDeps
): Promise<{ code: MomentStateCode; message: string } | undefined> {
    const status = record.recording?.status;

    if (status === "recording" || status === "paused") {
        return { code: "recording", message: `${record.id} is still being recorded; its audio is not final yet.` };
    }

    if (!(deps.hasFfmpeg ?? (() => Boolean(Bun.which("ffmpeg"))))()) {
        return {
            code: "no-ffmpeg",
            message: "ffmpeg is not installed (brew install ffmpeg); it cuts the clip to listen to.",
        };
    }

    try {
        await opened.audioPath();
        return undefined;
    } catch (error) {
        return { code: "no-audio", message: error instanceof Error ? error.message : String(error) };
    }
}

export async function planMomentCall(
    params: MeetingsParsedParams<"moment.plan">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"moment.plan">> {
    const record = recordOf(store, params.meeting);
    const opened = openedOf(store, record, deps);
    let moment: Awaited<ReturnType<typeof openMoment>>;

    try {
        moment = await openMoment({
            store,
            record,
            target: params.target,
            opened,
            ...(params.padSec === undefined ? {} : { padSec: params.padSec }),
            ...(params.screen === undefined ? {} : { screen: params.screen }),
        });
    } catch (error) {
        if (error instanceof MomentError) {
            return { cannot: { code: error.code, message: error.message } };
        }

        throw error;
    }

    const cannot = await cannotPlay(record, opened, deps);
    return { moment, ...(cannot ? { cannot } : {}) };
}

export async function clipMomentCall(
    params: MeetingsParsedParams<"moment.clip">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"moment.clip">> {
    const record = recordOf(store, params.meeting);
    const opened = openedOf(store, record, deps);
    const cannot = await cannotPlay(record, opened, deps);

    if (cannot) {
        throw unplayable(cannot.code, cannot.message);
    }

    try {
        return await clipMoment({
            store,
            record,
            target: params.target,
            opened,
            ...(params.padSec === undefined ? {} : { padSec: params.padSec }),
            ...(params.screen === undefined ? {} : { screen: params.screen }),
            ...(deps.cut ? { cut: deps.cut } : {}),
            ...(deps.probe ? { probe: deps.probe } : {}),
            control: {
                ...(context.signal ? { signal: context.signal } : {}),
                onProgress: (fraction) => context.progress?.({ fraction, label: "cutting the clip" }),
            },
        });
    } catch (error) {
        if (error instanceof MomentError) {
            throw unplayable(error.code, error.message);
        }

        throw error;
    }
}

/** A refusal of a Moment, with the reason a `moment.plan` would name. */
function unplayable(reason: string, message: string) {
    return refusal("unplayable", message, { reason });
}

export async function previewTone(
    params: MeetingsParsedParams<"tone.preview">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"tone.preview">> {
    const config = params.sound ? undefined : await (deps.config ?? (() => new MeetingsConfigStore().read()))();
    const sound = params.sound ?? config?.global.playback.listen.tone.sound;

    if (!sound) {
        throw refusal("failed", "no tone sound to preview");
    }

    const key = Bun.hash(`${sound.hz}:${sound.sec}:${sound.volume}`).toString(36);
    const path = join(toolDataDir("meetings-cache", "tones"), `tone-${key}.wav`);

    if (!existsSync(path)) {
        await (deps.tone ?? cutTone)(sound, path);
        log.debug({ path, sound }, "tone preview made");
    }

    return { path, sound: { hz: sound.hz, sec: sound.sec, volume: sound.volume } };
}

export async function readMeetingAudio(
    params: MeetingsParsedParams<"meeting.audio">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.audio">> {
    const record = recordOf(store, params.meeting);
    let path: string;

    try {
        path = await openedOf(store, record, deps).audioPath();
    } catch (error) {
        throw unplayable("no-audio", error instanceof Error ? error.message : String(error));
    }

    const probe = await (deps.probe ?? probeAudio)(path);
    return { path, ...probe };
}
