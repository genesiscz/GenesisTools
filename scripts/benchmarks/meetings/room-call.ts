import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EMBEDDING_MODEL } from "@genesiscz/utils/ai/local/runtimes/sherpa/models";
import { env } from "@genesiscz/utils/env";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { createGit } from "@genesiscz/utils/git";
import { sha256Json } from "@genesiscz/utils/hash";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { nameKey } from "@genesiscz/utils/meetings/people";
import { type MeetingItem, type MeetingRecord, MeetingStore, voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { meetingSeatsSchema } from "@genesiscz/utils/meetings/seats";
import { predictionPrints, readVoiceLibrary } from "@genesiscz/utils/meetings/voice-library";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { OpenedMeeting } from "../../../src/meetings/lib/opened-meeting";
import { baselineStays } from "../../../src/meetings/lib/person-stays";
import { NONE_OF_THESE, openQuestions } from "../../../src/meetings/lib/questions";
import { reviewRows } from "../../../src/meetings/lib/review-rows";
import {
    freezeRoomCall,
    measureRoomCallFiles,
    type RoomCallPrediction,
    type RoomCallSnapshot,
    roomCallHoldout,
    roomCallScenario,
} from "../../../src/meetings/lib/room-call-metrics";
import { correctTranscript, lineOf } from "../../../src/meetings/lib/transcript-corrections";

const args = parseArgs({
    options: {
        reference: { type: "string" },
        baseline: { type: "string" },
        candidate: { type: "string" },
        holdout: { type: "string" },
        out: { type: "string" },
        freeze: { type: "string" },
        archives: { type: "string" },
        library: { type: "string" },
        capture: { type: "string" },
        meeting: { type: "string" },
    },
}).values;

function required(key: keyof typeof args) {
    const value = args[key];
    if (!value) {
        throw new Error(`Missing --${key}`);
    }
    return value;
}
const read = (file: string): unknown => SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
const revision = () => createGit({ cwd: moduleDir(import.meta) }).getSha("HEAD");

async function freeze() {
    const spec = roomCallScenario
        .omit({ runs: true, libraryHash: true })
        .extend({
            seated: meetingSeatsSchema,
            historicalRemote: z.string().min(1),
        })
        .parse(read(required("freeze")));
    const code = (await revision()).trim();
    const archives = ["master", "head", "c6-muted"].map((tag) => {
        const dir = join(required("archives"), tag);
        const rev = /^head ([0-9a-f]{7,40})$/.exec(readFileSync(join(dir, "head.txt"), "utf8").trim());
        if (!rev) {
            throw new Error(`Missing archived revision in ${dir}`);
        }
        return { revision: rev[1]!, transcript: read(join(dir, "auto-transcript-suggested.json")) };
    });
    const manifest = freezeRoomCall({
        reference: read(required("reference")),
        remote: spec.historicalRemote,
        archives,
        scenario: {
            ...spec,
            libraryHash: await sha256FileAsync(required("library")),
            runs: { baseline: { revision: code, seats: null }, candidate: { revision: code, seats: spec.seated } },
        },
    });
    // These are archive controls, independent of how the new candidate performs.
    if (
        manifest.lines.length !== 1518 ||
        manifest.originalRemote.length !== 123 ||
        manifest.history[2]?.correctOnOriginalRemote !== 75 ||
        ![39, 68, 123].every((sec, i) => manifest.originalRemote[i]?.startSec === sec)
    ) {
        throw new Error(
            `Historical columns do not reproduce the frozen cohort: ${manifest.originalRemote.length} lines, ${manifest.history[2]?.correctOnOriginalRemote} recovered`
        );
    }
    return manifest;
}

// The CLI's capture process alone replaces the provider of temporary target-meeting training rows.
// Its downstream labelers, review ranking and transcript renderer are the ones under evaluation.
function excludeTemporarySeeds() {
    let calls = 0;
    Bun.plugin({
        name: "held-out-meeting-seeds",
        setup(build) {
            build.onLoad({ filter: /[/\\]speaker-labels[/\\]voice-seeds\.ts$/ }, () => ({
                loader: "object",
                exports: {
                    meetingVoiceSeeds: () => {
                        calls++;
                        return { certain: new Map(), seatOnlySeeds: new Set() };
                    },
                },
            }));
        },
    });
    return () => calls;
}

function predictions(options: {
    record: MeetingRecord;
    source: TranscriptEntry[];
    transcript: ReturnType<typeof correctTranscript>;
    people: string[];
}): RoomCallPrediction[] {
    const { record, source, transcript } = options;
    const known = new Set(
        [...options.people, ...transcript.speakers.map((row) => row.name)].map((person) => person.normalize())
    );
    const sourceById = new Map(source.map((line, i) => [line.id, { line, i }]));
    if (sourceById.has(undefined) || sourceById.size !== source.length) {
        throw new Error("Missing or duplicate source transcript IDs");
    }
    const ranges = record.items.filter(
        (item): item is Extract<MeetingItem, { kind: "speaker-range" }> =>
            item.kind === "speaker-range" && item.status === "suggested"
    );
    const questions = openQuestions(record).filter((item) => item.about === "speaker");
    const owner = new Map<string, string>();
    for (const q of questions) {
        for (const range of q.decides) {
            if (!owner.has(range)) {
                owner.set(range, q.id);
            }
        }
    }
    const rows = reviewRows(record, { minPriority: 0, lowPriority: "show" });
    const choicesByItem = new Map(rows.rows.map((row) => [row.id, row.choices]));
    const spans = new TranscriptLines(transcript.entries);
    return transcript.entries.map((entry, index) => {
        const { id, startSec } = entry;
        const endSec = spans.end(index);
        const original = sourceById.get(id);
        if (!original || !id || startSec === undefined || endSec === undefined || original.line.startSec !== startSec) {
            throw new Error(`Missing or changed transcript source at ${id ?? index}`);
        }
        const key = { id, startSec, endSec };
        // A questioned time may also cover a different person's *named* line.
        const open = entry.unclear || entry.guess || entry.band === "open" || entry.band === "guess";
        if (!open) {
            return { ...key, named: known.has(entry.speaker.normalize()) ? entry.speaker : null, choices: [] };
        }
        const covering = ranges.filter(
            (range) =>
                range.label === original.line.speaker &&
                startSec >= range.fromSec &&
                startSec <= range.toSec &&
                (lineOf(range) === undefined || lineOf(range) === original.i)
        );
        // The renderer consumes open speaker questions first, in openQuestions order.
        const q = questions.find((question) => covering.some((range) => owner.get(range.id) === question.id));
        const item = q ?? covering.at(-1);
        const choices = new Map<string, number | null>();
        for (const choice of (item && choicesByItem.get(item.id)) ?? []) {
            if ((choice.role === "suggested" || choice.role === "candidate") && choice.value !== NONE_OF_THESE) {
                choices.set(choice.value.normalize(), choice.confidence ?? null);
            }
        }
        // An unscored transcript reading is an offer, never evidence of a unique lead from menu order.
        for (const reading of entry.unclear?.readings ?? []) {
            const person = reading.normalize();
            if (known.has(person) && !choices.has(person)) {
                choices.set(person, null);
            }
        }
        if (entry.guess && entry.suggestedSpeaker && !choices.size) {
            choices.set(entry.suggestedSpeaker, entry.confidence ?? null);
        }
        return { ...key, named: null, choices: Array.from(choices, ([person, score]) => ({ person, score })) };
    });
}

async function capture(): Promise<RoomCallSnapshot> {
    const calls = excludeTemporarySeeds();
    const arm = z.enum(["baseline", "candidate"]).parse(args.capture);
    const file = required("holdout");
    const rawManifest = read(file);
    const manifest = roomCallHoldout.parse(rawManifest);
    const run = manifest.runs[arm];
    const code = (await revision()).trim();
    if (code !== run.revision) {
        throw new Error(`Expected ${run.revision}, running ${code}`);
    }
    // Keep the clone next to its manifest. A mistaken home must never select the original store.
    if (
        !env.tools.hasExplicitHome() ||
        realpathSync(env.tools.getHome()) !== realpathSync(join(dirname(file), arm, "home"))
    ) {
        throw new Error(`Capture requires GENESIS_TOOLS_HOME=<manifest directory>/${arm}/home`);
    }
    const store = new MeetingStore();
    const record = store.read(required("meeting"));
    if (
        !record?.project ||
        record.id === manifest.source.rootMeeting ||
        voiceRootMeeting(store, record) !== manifest.source.rootMeeting
    ) {
        throw new Error("Capture needs an undecided duplicate of the frozen source meeting with its project");
    }
    const journal = join(store.folder(record.id), "decisions.ndjson");
    if (
        record.items.length ||
        record.speakers.assignments?.length ||
        Object.keys(record.speakers.labels).length ||
        record.evidence?.voice ||
        record.seats ||
        (existsSync(journal) && readFileSync(journal, "utf8").trim())
    ) {
        throw new Error(
            "Remove cached decisions, labels, voice matches and seats from the scratch duplicate before capture"
        );
    }
    const opened = OpenedMeeting.of(store, record);
    const config = await opened.config();
    const audio = realpathSync(await opened.audioPath());
    if (
        relative(realpathSync(store.root), audio).startsWith("..") ||
        config.global.playback.tracks !== "source" ||
        !record.evidence?.channels ||
        record.evidence.channels.layout === "unknown"
    ) {
        throw new Error("Capture needs a calibrated scratch recording with playback.tracks=source");
    }
    if ((await sha256FileAsync(audio)) !== manifest.source.audioSha256) {
        throw new Error("Recording differs from the frozen audio");
    }
    const libraryHash = await sha256FileAsync(toolDataDir("meetings", "voice-library", "library.json"));
    const view = readVoiceLibrary();
    if (
        libraryHash !== manifest.libraryHash ||
        view.conflicts.length ||
        view.library.samples.some(
            (s) => s.source.rootMeeting === manifest.source.rootMeeting || s.sourceSha === manifest.source.audioSha256
        ) ||
        view.library.rejected.some(
            (r) =>
                r.source.rootMeeting === manifest.source.rootMeeting ||
                r.source.recordingKey.includes(manifest.source.audioSha256)
        )
    ) {
        throw new Error("Library differs from the frozen library, conflicts or contains train/test overlap");
    }
    const prints = predictionPrints({
        project: record.project,
        scope: config.global.speakerLabels.voice.sampleScope,
        view,
    });
    const training = prints.samples.map((s) => ({
        id: s.id,
        meeting: s.meeting,
        rootMeeting: s.source.rootMeeting,
        audioSha256: s.sourceSha,
        person: s.owner.name,
        fromSec: s.fromSec,
        toSec: s.toSec,
        origin: s.origin,
    }));
    const meeting = await opened.meeting();
    const evidence = await opened.evidence();
    const indicator = record.evidence.indicator ?? evidence?.speaking ?? [];
    const stays = baselineStays(record, manifest.roomTarget);
    const reads = indicator.filter(
        (r) =>
            !r.reason &&
            Number.isFinite(r.tSec) &&
            r.tSec >= 0 &&
            (r.validUntilSec === undefined || r.validUntilSec > r.tSec) &&
            (!stays || stays.some(({ stay }) => r.tSec >= stay.fromSec && r.tSec < (stay.toSec ?? Infinity)))
    );
    const explicit = reads.filter((r) => r.muted !== undefined).sort((a, b) => a.tSec - b.tSec);
    const muted = (r: (typeof explicit)[number]) => r.muted?.some((p) => nameKey(p) === nameKey(manifest.roomTarget));
    const included = explicit.filter(muted);
    const last = included.at(-1)?.tSec;
    if (
        last === undefined ||
        last !== manifest.mute.lastPositiveSec ||
        explicit.find((r) => r.tSec > last)?.tSec !== manifest.mute.firstOmittedSec
    ) {
        throw new Error("The observed mute-read boundaries differ from the manifest");
    }
    const muteHint = {
        person: manifest.roomTarget,
        included: included.length,
        explicit: explicit.length,
        missing: reads.length - explicit.length,
    };
    const modelHash = await sha256FileAsync(EMBEDDING_MODEL.file);
    const inputHash = sha256Json([
        Bun.version,
        modelHash,
        view.merges,
        view.knownOwners,
        meeting.sourceMeetingId,
        meeting.transcript,
        record.participants,
        record.attendance,
        record.evidence.channels,
        indicator,
        evidence?.speaking,
        evidence?.segments,
    ]);
    record.evidence.indicator = indicator;
    const { seatSuggestion } = await import("../../../src/meetings/lib/service/seat-handlers");
    const preview = await seatSuggestion({ store, record, params: {} });
    if (run.seats) {
        record.seats = run.seats;
    }
    const { previewSuggestions } = await import("../../../src/meetings/lib/suggest-run");
    const { applySuggestionChanges } = await import("../../../src/meetings/lib/suggest");
    const result = await previewSuggestions({ store, record, rules: ["speakers", "evidence"] });
    if (run.seats && (!config.global.speakerLabels.voice.enabled || !calls())) {
        throw new Error("The held-out voice pass did not reach the seed exclusion");
    }
    applySuggestionChanges(record, result.changes);
    const transcript = correctTranscript({
        record,
        transcript: meeting.transcript,
        config,
        format: "json",
        withSuggested: true,
    });
    return {
        ...run,
        source: manifest.source,
        holdoutHash: sha256Json(rawManifest),
        libraryHash,
        inputHash,
        configHash: sha256Json(config),
        runtime: { bun: Bun.version, model: prints.model, modelHash },
        training,
        cachedDecisions: 0,
        temporarySeeds: 0,
        muteHint,
        undecidedSeatPreview: preview.suggestion.people,
        warnings: result.warnings,
        rows: predictions({
            record,
            source: meeting.transcript,
            transcript,
            people: [manifest.people.owner, ...manifest.people.room, ...manifest.people.remote],
        }),
    };
}

const target = resolve(required("out"));
if (existsSync(target)) {
    throw new Error(`Use a new output path to preserve frozen inputs and previous results: ${target}`);
}
const report = args.freeze
    ? await freeze()
    : args.capture
      ? await capture()
      : measureRoomCallFiles({
            reference: required("reference"),
            baseline: required("baseline"),
            candidate: required("candidate"),
            holdout: required("holdout"),
        });
await atomicWriteFileStreamed(target, (write) => write(Buffer.from(SafeJSON.stringify(report, null, 2))), {
    mode: 0o600,
    exclusive: true,
});
out.print(`${target}\n`);
