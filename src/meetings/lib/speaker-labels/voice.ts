import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
    type MeetingsConfig,
    MeetingsConfigStore,
    type VoiceComputePriority,
    voiceWorkerCount,
} from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { embedVoiceLines } from "@genesiscz/utils/meetings/voice";
import { readVoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { priorityShellArgv } from "@genesiscz/utils/process/priority";
import type { OpenedMeeting } from "../opened-meeting";
import { type MeetingSound, measureSoundClock, meetingSound, readSoundInputs, saveSoundClock } from "../sound";
import { nameByVoice, type VoiceLine } from "../voice-names";
import type { LabelContext, SpeakerLabeler } from "./types";

/**
 * The argv prefix that starts a voice worker at `priority`. `normal` clears any background state the caller inherited
 * (a service started by launchd), so the worker runs on the fast cores; `background` is `taskpolicy -b`.
 */
export function voiceWorkerPrefix(priority: VoiceComputePriority): string[] {
    return [...priorityShellArgv('exec "$@"', priority === "background" ? "low" : "high"), "voice-worker"];
}

/** How a voice pass runs here, from `speakerLabels.voice.compute` (the store's config when none is passed). */
export async function voiceWorkerSettings(config?: MeetingsConfig): Promise<{ prefix: string[]; workers: number }> {
    const compute = (config ?? (await new MeetingsConfigStore().read())).global.speakerLabels.voice.compute;
    return {
        prefix: voiceWorkerPrefix(compute.priority),
        workers: voiceWorkerCount(compute.workers, availableParallelism()),
    };
}

/** Batches spans on the same file/channel while retaining transcript-clock times on the resulting line. */
export async function embedSeatLines(
    context: Pick<LabelContext, "lines" | "sound"> & { cachePath?: string }
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
    const { prefix } = await voiceWorkerSettings();
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
    for (const group of groups.values()) {
        group.lines.sort((a, b) => a.slice.fileFromSec - b.slice.fileFromSec);
        const embeddings = await embedVoiceLines({
            audioPath: group.path,
            cachePath: context.cachePath,
            workerPrefix: prefix,
            spans: group.lines.map(({ line, slice }) => ({
                index: line.index,
                fromSec: slice.fileFromSec,
                toSec: slice.fileToSec,
            })),
            channels: [
                { channel: group.channel, track: group.lines[0]!.line.seat === "mic" ? "raw-mic" : "isolated-call" },
            ],
        });
        for (const embedding of embeddings) {
            const { line, slice } = group.lines.find((entry) => entry.line.index === embedding.index)!;
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
            let sound = context.sound;
            if (sound.tracks.some((track) => track.from.kind === "recorder" && track.clock === "stamp")) {
                const inputs = await readSoundInputs(options.opened);
                if (inputs.clock) {
                    sound = meetingSound(inputs);
                } else if (inputs.tracks === "best") {
                    const measured = await measureSoundClock(inputs);
                    if (measured) {
                        saveSoundClock(inputs.folder, measured.clock);
                        sound = meetingSound({ ...inputs, clock: measured.clock });
                    }
                }
            }
            return nameByVoice({
                ...options.settings,
                store,
                attended: context.attended,
                lines: await embedSeatLines({
                    lines: context.lines,
                    sound,
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
