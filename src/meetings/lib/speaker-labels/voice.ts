import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { measureCpuBusyPercent, readPerformanceCores } from "@genesiscz/utils/macos/host-stats";
import {
    type MeetingsConfig,
    MeetingsConfigStore,
    type VoiceComputePriority,
    type VoiceFreeCores,
    voiceWorkerCount,
} from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { embedVoiceLines, type VoiceProgress } from "@genesiscz/utils/meetings/voice";
import { readVoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { backgroundPrefix } from "@genesiscz/utils/process/priority";
import { profiler } from "@genesiscz/utils/profile";
import type { OpenedMeeting } from "../opened-meeting";
import { type MeetingSound, measureSoundClock, meetingSound, readSoundClock, saveSoundClock } from "../sound";
import { nameByVoice, type VoiceLine } from "../voice-names";
import type { LabelContext, SpeakerLabeler } from "./types";

const prof = profiler.scope("meetings-suggest");

/** How a voice worker starts: an argv prefix, and whether it takes itself out of background as its first act. */
export interface VoiceWorkerStart {
    prefix: string[];
    clearBackground: boolean;
}

/**
 * The start of a voice worker at `priority`. `normal`: Bun starts directly and the worker calls `clearOwnBackground`
 * (setpriority through bun:ffi), so it runs on the fast cores even under a background service, with no perl or shell
 * process. `background`: `taskpolicy -b`.
 */
export function voiceWorkerStart(priority: VoiceComputePriority): VoiceWorkerStart {
    return priority === "background"
        ? { prefix: backgroundPrefix(), clearBackground: false }
        : { prefix: [], clearBackground: true };
}

/** One pass shares the same auto count across all its file/channel groups, sampled on the first worker start. */
export async function voicePassSettings(
    config?: MeetingsConfig,
    free: () => Promise<VoiceFreeCores> = freeCores
): Promise<VoiceWorkerStart & { workers: number | (() => Promise<number>) }> {
    const compute = (config ?? (await new MeetingsConfigStore().read())).global.speakerLabels.voice.compute;
    const start = voiceWorkerStart(compute.priority);
    if (compute.workers !== "auto") {
        return { ...start, workers: compute.workers };
    }

    let sampled: Promise<number> | undefined;
    return {
        ...start,
        workers: () =>
            (sampled ??= prof.measureAsync("voices.worker-settings", async () =>
                voiceWorkerCount("auto", await free())
            )),
    };
}

/** Resolve the settings immediately for a caller that needs the numeric worker count. */
export async function voiceWorkerSettings(
    config?: MeetingsConfig,
    free: () => Promise<VoiceFreeCores> = freeCores
): Promise<VoiceWorkerStart & { workers: number }> {
    const { workers, ...start } = await voicePassSettings(config, free);
    return { ...start, workers: typeof workers === "number" ? workers : await workers() };
}

/** A one-second CPU sample (`measureCpuBusyPercent`); without the kernel read, all cores minus the one-minute load. */
async function freeCores(): Promise<VoiceFreeCores> {
    const cores = availableParallelism();
    const busy = await measureCpuBusyPercent();
    return {
        performanceCores: readPerformanceCores() ?? Math.max(1, Math.floor(cores / 2)),
        idleCores: busy === null ? Math.max(0, cores - (loadavg()[0] ?? 0)) : (cores * (100 - busy)) / 100,
    };
}

/** Each suggest call owns a fresh OpenedMeeting, including concurrent calls on the same record. */
export const voiceProgressForMeeting = new WeakMap<OpenedMeeting, VoiceProgress>();

/** Batches spans on the same file/channel while retaining transcript-clock times on the resulting line. */
export async function embedSeatLines(
    context: Pick<LabelContext, "lines"> & {
        sound: MeetingSound;
        cachePath?: string;
        config?: MeetingsConfig;
        onProgress?: VoiceProgress;
    }
): Promise<VoiceLine[]> {
    const groups = new Map<
        string,
        {
            path: string;
            channel: 0 | 1;
            lines: Array<{
                line: LabelContext["lines"][number];
                slice: NonNullable<ReturnType<MeetingSound["slice"]>>;
            }>;
        }
    >();
    const result: VoiceLine[] = [];
    for (const line of context.lines) {
        const slice = context.sound.slice({ ...line, purpose: "voice" });
        if (!slice) {
            result.push({ ...line, track: line.seat === "mic" ? "source-mic" : "source-call", channels: [] });
            continue;
        }
        const channel = slice.channel ?? 0;
        const key = `${slice.path}\0${channel}`;
        const group = groups.get(key) ?? { path: slice.path, channel, lines: [] };
        group.lines.push({ line, slice });
        groups.set(key, group);
    }
    let completed = result.length;
    // Sampling idle cores takes a second in auto mode. No worker is started for uncovered lines.
    if (!groups.size) {
        context.onProgress?.(completed, context.lines.length);
        return result.sort((a, b) => a.index - b.index);
    }
    const worker = await voicePassSettings(context.config);
    context.onProgress?.(completed, context.lines.length);
    for (const group of groups.values()) {
        group.lines.sort((a, b) => a.slice.fileFromSec - b.slice.fileFromSec);
        const embeddings = await embedVoiceLines({
            audioPath: group.path,
            cachePath: context.cachePath,
            workerPrefix: worker.prefix,
            clearBackground: worker.clearBackground,
            workers: worker.workers,
            onProgress:
                context.onProgress &&
                ((done) => {
                    if (done > 0) {
                        context.onProgress?.(completed + done, context.lines.length);
                    }
                }),
            spans: group.lines.map(({ line, slice }) => ({
                index: line.index,
                fromSec: slice.fileFromSec,
                toSec: slice.fileToSec,
            })),
            channels: [
                { channel: group.channel, track: group.lines[0]!.line.seat === "mic" ? "raw-mic" : "isolated-call" },
            ],
        });
        completed += group.lines.length;
        for (const [position, embedding] of embeddings.entries()) {
            const { line, slice } = group.lines[position]!;
            result.push({ ...embedding, ...line, track: slice.track });
        }
    }
    return result.sort((a, b) => a.index - b.index);
}

export function voiceLabeler(options: {
    opened: OpenedMeeting;
    settings: MeetingsConfig["global"]["speakerLabels"]["voice"];
}): SpeakerLabeler {
    return {
        id: "voice",
        rule: MeetingRule.VoiceEmbedding,
        async propose(context) {
            if (!context.project || !context.attended.some((stay) => stay.seat)) {
                return [];
            }
            const store = readVoiceStore(context.project);
            if (!Object.keys(store.people).length) {
                return [];
            }
            let sound =
                context.sound ?? (await prof.measureAsync("speakers.sound-inputs", () => options.opened.sound()));
            {
                using _clock = prof.section("speakers.sound-clock");
                // Read-only previews supply their own sound without stamp tracks.
                if (sound.tracks.some((track) => track.from.kind === "recorder" && track.clock === "stamp")) {
                    const inputs = await options.opened.soundInputs();
                    // Another run may have saved the measurement since this snapshot was opened.
                    const clock = readSoundClock(inputs.folder);
                    if (clock) {
                        sound = meetingSound({ ...inputs, clock });
                    } else if (inputs.tracks === "best") {
                        const measured = await measureSoundClock(inputs);
                        if (measured) {
                            saveSoundClock(inputs.folder, measured.clock);
                            sound = meetingSound({ ...inputs, clock: measured.clock });
                        }
                    }
                }
            }
            using _pass = prof.section("voices.pass");
            return nameByVoice({
                ...options.settings,
                store,
                attended: context.attended,
                lines: await embedSeatLines({
                    lines: context.lines,
                    sound,
                    config: await options.opened.config(),
                    onProgress: voiceProgressForMeeting.get(options.opened),
                    cachePath: join(
                        options.opened.store.folder(options.opened.record.id),
                        "evidence",
                        "voice-lines.json"
                    ),
                }),
            });
        },
    };
}
