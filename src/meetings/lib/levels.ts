import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePinnedBinaryAsync } from "@app/control/lib/runner";
import { abortableSleep } from "@genesiscz/utils/async";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { CHANNEL_LAYOUTS } from "@genesiscz/utils/meetings/energy";
import { type MeetingLevelRow, MeetingLevels } from "@genesiscz/utils/meetings/levels";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { NativeFrameRecorder } from "@genesiscz/utils/screen-recorder/native";
import { z } from "zod";

const levelFile = (folder: string) => join(folder, "evidence", "levels.jsonl");
const channel = z.object({
    dbfs: z.number().nullable(),
    sampled: z.boolean(),
    device: z.string().nullable(),
    muted: z.boolean(),
});
const rowSchema = z.object({
    at: z.iso.datetime(),
    mic: channel,
    system: channel,
    paused: z.boolean(),
    micShare: z.number().nullable(),
    voiceMicShare: z.number().nullable(),
    calibration: z.object({
        layout: z.enum(CHANNEL_LAYOUTS),
        segments: z.object({ mic: z.number(), system: z.number() }),
        micMedian: z.number().optional(),
        systemMedian: z.number().optional(),
        sourceMicShare: z.number().optional(),
        reason: z.string().optional(),
    }),
});

export function appendMeetingLevels(folder: string, row: MeetingLevelRow): void {
    const file = levelFile(folder);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${SafeJSON.stringify(row)}\n`, { mode: 0o600 });
}

export function savedMeetingLevels(store: MeetingStore, ref: string): MeetingLevelRow[] {
    const record = store.resolve(ref);
    if (!record) {
        throw new Error(`No meeting "${ref}".`);
    }
    const file = levelFile(store.folder(record.id));
    if (!existsSync(file)) {
        return [];
    }
    const rows: MeetingLevelRow[] = [];
    let lineNumber = 0;
    for (const line of readLinesSync(file)) {
        lineNumber++;
        if (!line.trim()) {
            continue;
        }
        try {
            rows.push(rowSchema.parse(SafeJSON.parse(line, { strict: true })));
        } catch (error) {
            logger.warn({ file, lineNumber, error }, "skipping a damaged meeting level reading");
        }
    }
    return rows;
}

export const monitorSeconds = z.number().int().min(1).max(60);

/** One bounded monitor, with no media files. Closing Settings or its stdin tears down the same native session. */
export async function liveMeetingLevels(options: {
    seconds: number;
    signal?: AbortSignal;
    onRow?: (row: MeetingLevelRow) => void;
    onWarning?: (message: string) => void;
}) {
    const seconds = monitorSeconds.parse(options.seconds);
    const config = await new MeetingsConfigStore().read();
    const levels = new MeetingLevels(config.global.speakerLabels.channels.minSeparation);
    const recorder = new NativeFrameRecorder({ axTool: async (opts) => [await ensurePinnedBinaryAsync(opts)] });
    const failed = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
    let lastUpdate = -Infinity;
    const session = await recorder.monitorLevels({
        request: { sources: ["mic", "system"], micDeviceId: config.global.capture.recorders.native.audio.micDevice },
        signal,
        onWarning: options.onWarning,
        onFailure: (error) => failed.abort(error),
        onLevels: (block) => {
            levels.observe(block);
            if (options.onRow && block.atMs - lastUpdate >= 240) {
                lastUpdate = block.atMs;
                options.onRow(levels.snapshot(block.atMs));
            }
        },
    });
    try {
        await abortableSleep(seconds * 1000, signal);
        return { ...levels.snapshot(Date.now()), warnings: [...session.warnings] };
    } finally {
        await session.stop();
    }
}
