import { randomUUID } from "node:crypto";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore, TONE_PRESET_NAMES, TONE_PRESETS } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { cutTone, probeAudio } from "../audio";
import { clipMoment, MomentError, openMoment } from "../moment";
import type { MomentStateCode } from "../moment-schema";
import { OpenedMeeting } from "../opened-meeting";
import { persistClip } from "../saved-clip";
import { resolveToneSound } from "../tone-sound";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsCallContext, type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's Moment methods (`moment.plan`, `moment.clip`, `tone.preview`, `tone.presets`,
 * `meeting.audio`): the Moment engine behind the service. Loaded by handlers.ts only when a call plays.
 */

const { log } = logger.scoped("meetings-service");

function openedOf(store: MeetingStore, record: MeetingRecord, deps: MeetingsHandlerDeps): OpenedMeeting {
    return OpenedMeeting.of(store, record, deps.linkedSource?.(record));
}

/** The members `moment.plan` and `moment.clip` pass on to the engine as they came. */
function momentOptions(params: MeetingsParsedParams<"moment.plan">, deps: MeetingsHandlerDeps) {
    return {
        ...(params.padSec === undefined ? {} : { padSec: params.padSec }),
        ...(params.padAfterSec === undefined ? {} : { padAfterSec: params.padAfterSec }),
        ...(params.toneSound === undefined ? {} : { toneSound: params.toneSound }),
        ...(params.tone === undefined ? {} : { tone: params.tone }),
        ...(params.lengthSec === undefined ? {} : { lengthSec: params.lengthSec }),
        ...(params.screen === undefined ? {} : { screen: params.screen }),
        ...(deps.probe ? { probeTone: deps.probe } : {}),
    };
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
            ...momentOptions(params, deps),
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
            ...momentOptions(params, deps),
            ...(deps.cut ? { cut: deps.cut } : {}),
            ...(deps.probe ? { probe: deps.probe } : {}),
            control: {
                ...(context.signal ? { signal: context.signal } : {}),
                onProgress: (fraction) => context.progress?.({ fraction, label: "cutting the clip" }),
            },
        });
    } catch (error) {
        if (error instanceof MomentError) {
            throw unplayable(error.code, error.message, error);
        }

        throw error;
    }
}

export async function saveMomentCall(
    params: MeetingsParsedParams<"moment.save">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"moment.save">> {
    const clip = await clipMomentCall(
        {
            ...params,
            padSec: params.padSec ?? 0,
            padAfterSec: params.padAfterSec ?? 0,
            tone: params.tone ?? false,
            screen: false,
        },
        context,
        store,
        deps
    );
    const saved = await persistClip({
        store,
        record: recordOf(store, params.meeting),
        clip,
        title: params.title,
        quote: params.quote,
        signal: context.signal,
        now: deps.now?.(),
    });
    if (saved.created) {
        context.emit?.("meeting.changed", { meeting: clip.meeting, parts: ["show"] });
    }
    return saved;
}

/** A refusal of a Moment, with the reason a `moment.plan` would name; one issue title per reason. */
function unplayable(reason: string, message: string, cause?: unknown) {
    return refusal(
        "unplayable",
        message,
        { reason },
        { cause, issue: { title: `A Moment does not play (${reason})` } }
    );
}

export async function previewTone(
    params: MeetingsParsedParams<"tone.preview">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"tone.preview">> {
    const config = await (deps.config ?? (() => new MeetingsConfigStore().read()))();
    const setting = params.sound ?? config.global.playback.listen.tone.sound;

    if (!setting) {
        throw refusal("failed", "no tone sound to preview");
    }

    const sound = await resolveToneSound(setting, {
        probe: deps.probe ?? probeAudio,
        onMissing: config.global.playback.listen.tone.onMissing,
    });
    // A sine keeps the key it had before sound files; a file's key holds its version, so an edited file is made again.
    const version = sound.file ? (({ mtimeMs, size }) => [mtimeMs, size])(statSync(sound.file)) : [];
    const key = Bun.hash(
        sound.file
            ? SafeJSON.stringify([sound.file, sound.sec, sound.volume, ...version])
            : `${sound.hz}:${sound.sec}:${sound.volume}`
    ).toString(36);
    const path = join(toolDataDir("meetings-cache", "tones"), `tone-${key}.wav`);

    if (!existsSync(path)) {
        // Made beside its place and renamed in only after success: a second preview never returns a half-written WAV,
        // and a failed run leaves nothing that a later preview would return instead of trying again.
        const pending = join(dirname(path), `.tone-${key}-${process.pid}-${randomUUID()}.wav`);

        try {
            await (deps.tone ?? cutTone)(sound, pending);
            renameSync(pending, path);
        } finally {
            if (existsSync(pending)) {
                unlinkSync(pending);
            }
        }

        log.debug({ path, sound }, "tone preview made");
    }

    return { path, sound };
}

/** `tone.presets`: every named tone, with whether this Mac has a file preset's sound. */
export function listTonePresets(): MeetingsResult<"tone.presets"> {
    return {
        presets: TONE_PRESET_NAMES.map((name) => {
            const { label, volume, sound } = TONE_PRESETS[name];
            return sound.kind === "file"
                ? { name, label, kind: "file", volume, file: sound.path, available: existsSync(sound.path) }
                : { name, label, kind: "sine", volume, hz: sound.hz, sec: sound.sec, available: true };
        }),
    };
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
        throw unplayable("no-audio", error instanceof Error ? error.message : String(error), error);
    }

    const probe = await (deps.probe ?? probeAudio)(path);
    return { path, ...probe };
}
