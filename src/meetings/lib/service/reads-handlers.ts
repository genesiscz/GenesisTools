import { join } from "node:path";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { channelEnergy, ENERGY_BLOCKS_PER_SEC } from "@genesiscz/utils/meetings/energy";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { DEFAULT_SPAN_GAP_SEC } from "@genesiscz/utils/transcribe/speakers";
import {
    configValueAt,
    missingMapKey,
    parseConfigPath,
    setConfigValue,
    unknownConfigPath,
    unsetConfigValue,
} from "../config-edit";
import { OpenedMeeting } from "../opened-meeting";
import { screenTimeline } from "../screen-timeline";
import { configShowRead, overviewRead, rowsRead, speakerStatsRead } from "../window-reads";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's reads for the timeline and the settings (`meeting.speakers`, `meeting.screen`,
 * `meeting.waveform`, `meetings.overview`, `config.*`). Loaded by handlers.ts only when a call asks for one of them.
 */

export async function readRows(
    params: MeetingsParsedParams<"meeting.rows">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.rows">> {
    const record = recordOf(store, params.meeting);
    const linked = deps.linkedSource?.(record);
    const config = deps.config ? await deps.config() : undefined;
    return rowsRead({
        store,
        record,
        ...(linked ? { linked } : {}),
        ...(config ? { minPriority: config.global.playback.listen.minPriority } : {}),
        ...(params.lowPriority ? { lowPriority: params.lowPriority } : {}),
    });
}

export async function readSpeakers(
    params: MeetingsParsedParams<"meeting.speakers">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.speakers">> {
    const record = recordOf(store, params.meeting);
    const linked = deps.linkedSource?.(record);
    return speakerStatsRead({
        store,
        record,
        ...(linked ? { linked } : {}),
        gapSec: params.gapSec ?? DEFAULT_SPAN_GAP_SEC,
        ...(params.attendance ? { attendance: params.attendance } : {}),
    });
}

export async function readScreen(
    params: MeetingsParsedParams<"meeting.screen">,
    store: MeetingStore
): Promise<MeetingsResult<"meeting.screen">> {
    const record = recordOf(store, params.meeting);
    let timeline: Awaited<ReturnType<typeof screenTimeline>>;

    try {
        timeline = await screenTimeline({ store, record });
    } catch (error) {
        // A meeting without a screen recording has no frames: the window shows no screen pane.
        if (error instanceof Error && error.message.includes("no screen recording")) {
            return { meeting: record.id, recorded: false, displays: [], frames: [] };
        }

        throw error;
    }

    const frames = timeline.frames
        .filter(
            (frame) =>
                (params.fromSec === undefined || frame.meetingSec >= params.fromSec) &&
                (params.toSec === undefined || frame.meetingSec <= params.toSec) &&
                (params.display === undefined || frame.displayId === params.display)
        )
        .map((frame) => ({
            file: frame.file,
            path: frame.path,
            meetingSec: frame.meetingSec,
            ...(frame.displayId === undefined ? {} : { displayId: frame.displayId }),
            width: frame.width,
            height: frame.height,
            lineCount: frame.lineCount,
        }));
    return { meeting: record.id, recorded: true, displays: timeline.displays, frames };
}

export async function readWaveform(
    params: MeetingsParsedParams<"meeting.waveform">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.waveform">> {
    const record = recordOf(store, params.meeting);
    const fromSec = params.fromSec ?? 0;
    const empty = (toSec: number, cannot: { code: "no-audio" | "no-ffmpeg" | "mono"; message: string }) => ({
        meeting: record.id,
        fromSec,
        toSec,
        peaks: [],
        cannot,
    });
    let audioPath: string;

    try {
        audioPath = await OpenedMeeting.of(store, record, deps.linkedSource?.(record)).audioPath();
    } catch (error) {
        return empty(params.toSec ?? fromSec, {
            code: "no-audio",
            message: error instanceof Error ? error.message : String(error),
        });
    }

    if (!(deps.hasFfmpeg ?? (() => Boolean(Bun.which("ffmpeg"))))()) {
        return empty(params.toSec ?? fromSec, {
            code: "no-ffmpeg",
            message: "ffmpeg is not installed (brew install ffmpeg).",
        });
    }

    // The channel energy the speaker rules read: 100 ms blocks, kept in the meeting folder and rebuilt when the
    // recording is newer, so the strip and every zoom read one table.
    const energy = await (deps.energy ?? channelEnergy)(
        audioPath,
        join(store.folder(record.id), "evidence", "energy.bin")
    );

    if (!energy) {
        return empty(params.toSec ?? fromSec, {
            code: "mono",
            message: "the recording has one channel; its energy is not kept yet.",
        });
    }

    const blocks = Math.min(energy.left.length, energy.right.length);
    const loudness = (block: number) => Math.max(energy.left[block] ?? 0, energy.right[block] ?? 0);
    let loudest = 0;

    for (let block = 0; block < blocks; block += 1) {
        loudest = Math.max(loudest, loudness(block));
    }

    const toSec = params.toSec ?? blocks / ENERGY_BLOCKS_PER_SEC;
    const span = Math.max(0, toSec - fromSec);
    const peaks = Array.from({ length: params.buckets }, (_, bucket) => {
        const first = Math.floor((fromSec + (span * bucket) / params.buckets) * ENERGY_BLOCKS_PER_SEC);
        const last = Math.max(
            first + 1,
            Math.ceil((fromSec + (span * (bucket + 1)) / params.buckets) * ENERGY_BLOCKS_PER_SEC)
        );
        let peak = 0;

        for (let block = first; block < Math.min(last, blocks); block += 1) {
            peak = Math.max(peak, loudness(block));
        }

        return loudest > 0 ? Math.round((peak / loudest) * 1000) / 1000 : 0;
    });
    return { meeting: record.id, fromSec, toSec, peaks };
}

export async function readOverview(params: MeetingsParsedParams<"meetings.overview">, store: MeetingStore) {
    return overviewRead({ days: params.days ?? 14, now: new Date(), store });
}

/** The refusal `config show` prints for a path that names no setting, or a map key that is not there. */
async function refuseUnknownPath(path: string): Promise<void> {
    const segments = parseConfigPath(path);
    const unknown = unknownConfigPath(segments);

    if (unknown) {
        throw refusal("failed", `${unknown.reason} Its settings: ${unknown.settings}`);
    }

    const missing = missingMapKey(await new MeetingsConfigStore().read(), segments);

    if (missing) {
        throw refusal("failed", `${missing.reason} Its settings: ${missing.settings}`);
    }
}

export async function readConfig(params: MeetingsParsedParams<"config.read">): Promise<MeetingsResult<"config.read">> {
    if (params.path) {
        const unknown = unknownConfigPath(parseConfigPath(params.path));

        if (unknown) {
            throw refusal("failed", `${unknown.reason} Its settings: ${unknown.settings}`);
        }
    }

    const view = await configShowRead(params.path);

    if (params.path && (view.value === null || view.value === undefined)) {
        await refuseUnknownPath(params.path);
    }

    return view;
}

export async function setConfig(params: MeetingsParsedParams<"config.set">): Promise<MeetingsResult<"config.set">> {
    const segments = parseConfigPath(params.path);
    const config = await setConfigValue(
        new MeetingsConfigStore(),
        params.path,
        params.value,
        params.expect === undefined ? {} : { expect: params.expect }
    );
    return { path: segments, value: configValueAt(config, segments) ?? null };
}

export async function unsetConfig(
    params: MeetingsParsedParams<"config.unset">
): Promise<MeetingsResult<"config.unset">> {
    const segments = parseConfigPath(params.path);
    const config = await unsetConfigValue(
        new MeetingsConfigStore(),
        params.path,
        params.expect === undefined ? {} : { expect: params.expect }
    );
    return { path: segments, value: configValueAt(config, segments) ?? null };
}
