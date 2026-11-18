import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { measureCpuBusyPercent, readPerformanceCores } from "@genesiscz/utils/macos/host-stats";
import {
    type MeetingsConfig,
    MeetingsConfigStore,
    type VoiceComputePriority,
    type VoiceFreeCores,
    voiceWorkerCount,
} from "@genesiscz/utils/meetings/config";
import { voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { embedVoiceLines, type VoiceProgress } from "@genesiscz/utils/meetings/voice";
import {
    groupedOwners,
    meetingVoiceOwner,
    predictionPrints,
    readVoiceLibrary,
    refused,
    type SampleSource,
    sameLine,
    sourceForVoicePrint,
    type VoiceLibrarySnapshot,
    type VoicePrint,
    type VoiceStore,
    voiceLineKeys,
} from "@genesiscz/utils/meetings/voice-library";
import { backgroundPrefix } from "@genesiscz/utils/process/priority";
import { profiler } from "@genesiscz/utils/profile";
import type { OpenedMeeting } from "../opened-meeting";
import { type MeetingSound, measureSoundClock, meetingSound, readSoundClock, saveSoundClock } from "../sound";
import { nameByVoice, type VoiceLine } from "../voice-names";
import type { LabelContext, LineLabel, SpeakerLabeler } from "./types";

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

/**
 * What `auto` means on this Mac now: the worker count a pass starting now takes (`voiceWorkerCount` of `freeCores`),
 * with the sample it came from. The Speakers settings page shows it through `voices.workers`, so no second copy of
 * the rule lives in Swift.
 */
export async function autoVoiceWorkers(
    free: () => Promise<VoiceFreeCores> = freeCores
): Promise<VoiceFreeCores & { auto: number }> {
    const cores = await free();
    return { auto: voiceWorkerCount("auto", cores), ...cores };
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
/** The call's abort signal for its voice pass (`$/cancel`, a closed connection): it kills the pass's workers. */
export const voiceSignalForMeeting = new WeakMap<OpenedMeeting, AbortSignal>();

/** Batches spans on the same file/channel while retaining transcript-clock times on the resulting line. */
export async function embedSeatLines(
    context: Pick<LabelContext, "lines"> & {
        sound: MeetingSound;
        cachePath?: string;
        config?: MeetingsConfig;
        onProgress?: VoiceProgress;
        signal?: AbortSignal;
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
            ...(context.signal ? { signal: context.signal } : {}),
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

async function meetingVoiceLines(opened: OpenedMeeting, context: LabelContext): Promise<VoiceLine[]> {
    let sound = context.sound ?? (await prof.measureAsync("speakers.sound-inputs", () => opened.sound()));
    {
        using _clock = prof.section("speakers.sound-clock");
        // Read-only previews supply their own sound without stamp tracks.
        if (sound.tracks.some((track) => track.from.kind === "recorder" && track.clock === "stamp")) {
            const inputs = await opened.soundInputs();
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
    return await embedSeatLines({
        lines: context.lines,
        sound,
        config: await opened.config(),
        onProgress: voiceProgressForMeeting.get(opened),
        signal: voiceSignalForMeeting.get(opened),
        cachePath: join(opened.store.folder(opened.record.id), "evidence", "voice-lines.json"),
    });
}

export function voiceLabeler(options: {
    opened: OpenedMeeting;
    settings: MeetingsConfig["global"]["speakerLabels"]["voice"];
    /** A threshold preview shares the same enrollment and in-memory embeddings across its scores. */
    voiceLibrary?: VoiceLibrarySnapshot;
    readLines?: (context: LabelContext, model: string) => Promise<VoiceLine[]>;
}): SpeakerLabeler {
    return {
        id: "voice",
        rule: MeetingRule.VoiceEmbedding,
        async propose(context) {
            if (!context.project || !context.attended.some((stay) => stay.seat)) {
                return [];
            }
            const view = options.voiceLibrary ?? readVoiceLibrary();
            const owners = context.attended.map((stay) => meetingVoiceOwner(options.opened.record, stay.person));
            const prints = predictionPrints({
                project: context.project,
                scope: options.settings.sampleScope,
                owners,
                view,
            });
            const directory = groupedOwners(view);
            const names = new Map(owners.map((owner) => [directory.select(owner), owner.name]));
            const store: VoiceStore = { version: 1, model: prints.model, people: Object.create(null) };
            const sources = new Map<VoicePrint, SampleSource>();
            for (const sample of prints.samples) {
                const name = names.get(directory.binding(sample.owner));
                if (name) {
                    const person: { samples: VoicePrint[] } = store.people[name] ?? { samples: [] };
                    person.samples.push(sample);
                    store.people[name] = person;
                    sources.set(sample, sample.source);
                }
            }
            if (!Object.keys(store.people).length && !context.certain?.size) {
                return [];
            }
            const root = voiceRootMeeting(options.opened.store, options.opened.record);
            const localRefusals = view.library.rejected.filter((r) => r.source.rootMeeting === root);
            const localSamples = view.library.samples.filter(
                (s) => s.source.rootMeeting === root && !refused(view.library, s.source, s.owner)
            );
            const lineKeys =
                localRefusals.length || localSamples.length ? voiceLineKeys(await options.opened.meeting()) : undefined;
            const lines = options.readLines
                ? await options.readLines(context, store.model)
                : await meetingVoiceLines(options.opened, context);
            const inputs = {
                ...options.settings,
                store,
                meeting: root,
                lineKeys,
                sources,
                applyAbove: context.applyAbove,
                attended: context.attended,
                lines,
            };
            const certain = new Map(context.certain);
            const hashes = new Map<string, string>();
            for (const line of lines) {
                const name = certain.get(line.index);
                const ready = line.channels.find((channel) => channel.quality === "ready");
                if (!name || !ready || (!localRefusals.length && !localSamples.length)) {
                    continue;
                }
                const file = ready.source.audioPath;
                const sha = hashes.get(file) ?? (await sha256FileAsync(file));
                hashes.set(file, sha);
                const source = sourceForVoicePrint(
                    {
                        meeting: root,
                        sourceSha: sha,
                        seat: line.seat,
                        track: line.track,
                        fromSec: line.fromSec ?? ready.fromSec,
                        toSec: line.toSec ?? ready.toSec,
                    },
                    root,
                    lineKeys?.[line.index]
                );
                const owner = meetingVoiceOwner(options.opened.record, name);
                const binding = directory.select(owner) ?? directory.binding(owner);
                const blockers = localRefusals.filter((r) => !r.owner || directory.binding(r.owner) === binding);
                if (
                    refused(view.library, source, owner) ||
                    blockers.some((r) => sameLine(r.source, source)) ||
                    localSamples.some((s) => sameLine(s.source, source) && directory.binding(s.owner) !== binding)
                ) {
                    certain.delete(line.index);
                }
            }
            // Several strangers on the same single-owner seat must not train one another as its owner.
            const vetoes = new Map<number, LineLabel>();
            if (context.seatOnlySeeds?.size && Object.keys(store.people).length) {
                const seatLines = lines.filter((line) => context.seatOnlySeeds?.has(line.index));
                for (const label of nameByVoice({ ...inputs, lines: seatLines, exclusion: undefined })) {
                    if (label.reason === "not-the-seat-person") {
                        certain.delete(label.index);
                        vetoes.set(label.index, label);
                    }
                }
            }
            return nameByVoice({ ...inputs, certain }).map((label) => vetoes.get(label.index) ?? label);
        },
    };
}
