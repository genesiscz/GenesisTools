import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wisprflowSource } from "@app/wisprflow/lib/meeting-source";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import * as voiceBackend from "@genesiscz/utils/meetings/voice";
import { addVoicePrint, readVoiceStore, type VoicePrint } from "@genesiscz/utils/meetings/voice-store";
import type { ChoiceSelectOptions } from "@genesiscz/utils/prompts/clack/choice-select";
import * as p from "@genesiscz/utils/prompts/p";
import { renderBrief } from "@genesiscz/utils/repl/discovery";
import { Storage } from "@genesiscz/utils/storage/storage";
import { createCanvas } from "@napi-rs/canvas";
import { Command } from "commander";
import { z } from "zod";
import { playbackSlice, playSoundSlice } from "../commands/play";
import { MEETINGS_REGISTRARS } from "../registrars";
import { meetingAudioPath } from "./audio";
import { MeetingComments } from "./comments";
import { journalEntrySchema } from "./decision-actions";
import { DecisionJournal } from "./decision-journal";
import { FRAME_INDEX_FILE } from "./frame-index";
import { meetingListRow, selectMeetings } from "./list-rows";
import { planMoment } from "./moment";
import { OpenedMeeting } from "./opened-meeting";
import { choosePlayer, PLAYERS, pastTheEnd, playbackPlan } from "./players";
import { decisionReachSchema } from "./service/api";
import { InProcessMeetingsClient } from "./service/client";
import { MeetingsServiceError } from "./service/handlers";
import * as momentHandlers from "./service/moment-handlers";
import { meetingsToolsetApi } from "./service/toolset-api";
import { enumHint, errorJSON, errorText, fail, formatFlag } from "./shared";
import * as soundModule from "./sound";
import { appendAudioRow, meetingSound } from "./sound";
import { preserveSourceAudio } from "./source-audio";
import { linkedSource } from "./sources";
import * as labelsModule from "./speaker-labels";
import * as suggestRun from "./suggest-run";
import {
    applyVoices,
    listProjectVoices,
    planVoiceRemoval,
    previewVoices,
    removeVoice,
    voiceReadMeeting,
    voiceSample,
} from "./voices";

/**
 * What the `tools meetings` commands promise a script or the Meetings window: a refusal names a command that runs,
 * an error code leads its sentence, a JSON shape stays. Each test pins one promise.
 */
test("brief meeting help exposes the screen attribution instruction", () => {
    const help = renderBrief(meetingsToolsetApi).split("\n");
    for (const method of ["meeting.evidence(", "meeting.items.byChannel("]) {
        expect(help.find((line) => line.includes(method))).toContain("Read screen --at before attributing");
    }
});

test("meeting help lists each handle method once", () => {
    const handles = meetingsToolsetApi.handles ?? [];
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
        const methods = handle.methods.map((method) => method.name);
        expect(new Set(methods).size).toBe(methods.length);
    }
});

test("voices has one tree, the voice alias, and all old and new subcommands", async () => {
    for (const requested of ["voices", "voice"]) {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested });
        const tree = program.commands.find((command) => command.name() === "voices")!;
        expect(tree.aliases()).toContain("voice");
        expect(tree.commands.map((command) => command.name()).sort()).toEqual([
            "add",
            "apply",
            "backfill",
            "collect",
            "enroll",
            "play",
            "prepare",
            "preview",
            "remove",
            "score",
        ]);
    }
});

test("voice backfill CLI accepts project, dry-run and JSON after the subcommand", async () => {
    const program = new Command().exitOverride();
    await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "voices" });
    const result = spyOn(out, "result").mockImplementation(() => undefined);
    try {
        await program.parseAsync(["voices", "backfill", "--project", "empty-backfill-fixture", "--dry-run", "--json"], {
            from: "user",
        });
        expect(SafeJSON.parse(String(result.mock.calls[0]?.[0]))).toEqual({
            added: 0,
            present: 0,
            rows: [],
            dryRun: true,
        });
    } finally {
        result.mockRestore();
    }
});

test("voice readiness hints from set and raw evidence leave stdout as a single JSON result", async () => {
    const store = new MeetingStore();
    const project = "evidence-readiness-fixture";
    const record = await store.create(
        {
            title: "Readiness evidence",
            start: "2026-11-01T10:00:00Z",
            createdBy: "new",
            sources: { wisprflow: { meetingId: "readiness-source" } },
        },
        { command: "new", change: "fixture" }
    );
    const mocks = [
        spyOn(wisprflowSource, "load").mockResolvedValue({
            sourceMeetingId: "readiness-source",
            title: record.title,
            start: record.start,
            participants: [],
            speakers: [],
            folders: [],
            transcript: [],
        }),
        spyOn(wisprflowSource, "evidence").mockResolvedValue(null),
        spyOn(wisprflowSource, "dictionary").mockResolvedValue([]),
    ];
    const info = spyOn(ui, "info").mockImplementation(() => {});
    const output = spyOn(out, "result").mockImplementation(() => {});
    const hints = [`tools meetings seats ${record.id} --apply`, `tools meetings voices backfill --project ${project}`];
    try {
        for (const [command, ...args] of [
            ["set", record.id, "--project", project],
            ["evidence", record.id, "--raw", "--word-check", "off"],
        ] as const) {
            info.mockClear();
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: command });
            await program.parseAsync([command, ...args], { from: "user" });
            expect(info.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining(hints));
        }
        expect(output).toHaveBeenCalledTimes(1);
        expect(SafeJSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
            voice: { seats: false, samples: 0, people: {}, ready: false, hints },
        });
    } finally {
        for (const mock of [...mocks, info, output]) {
            mock.mockRestore();
        }
    }
});

test("play's positional time and track reach the original track's file seconds without starting sound", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Track", start: "2026-11-01T10:00:00Z", createdBy: "new" },
        { command: "new", change: "fixture" }
    );
    const sound = meetingSound({
        folder: "/fixture",
        timelineZeroMs: 0,
        tracks: "best",
        rows: [{ file: "mic.m4a", source: "mic", at: "1970-01-01T00:00:10Z", durationMs: 30000, mutedSpans: [] }],
    });
    const opened = spyOn(OpenedMeeting.prototype, "sound").mockResolvedValue(sound);
    const printed = spyOn(out, "result").mockImplementation(() => {});
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        throw new Error("must not play");
    });
    const model = spyOn(voiceBackend, "localVoiceBackend").mockImplementation(() => {
        throw new Error("play must not load a voice model");
    });
    const embed = spyOn(voiceBackend, "embedVoiceLines").mockRejectedValue(new Error("play must not embed a meeting"));
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "play" });
        await program.parseAsync(
            ["play", record.id, "15", "--track", "mic-raw", "--before", "0", "--no-start", "--json"],
            { from: "user" }
        );
        expect(SafeJSON.parse(String(printed.mock.calls.at(-1)?.[0]), { strict: true })).toMatchObject({
            track: "mic-raw",
            path: "/fixture/mic.m4a",
            fileFromSec: 5,
            fileToSec: 30,
            clock: "stamp",
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
        expect(embed).not.toHaveBeenCalled();
    } finally {
        opened.mockRestore();
        printed.mockRestore();
        spawn.mockRestore();
        model.mockRestore();
        embed.mockRestore();
        process.exitCode = 0;
    }
});

test("default play chooses the line seat's best track and source setting is respected", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Seat", start: "2026-11-01T10:00:00Z", createdBy: "new" },
        { command: "new", change: "fixture" }
    );
    const opened = OpenedMeeting.of(store, record);
    const base = {
        folder: "/fixture",
        timelineZeroMs: 0,
        rows: [
            { file: "mic.m4a", source: "mic" as const, at: "1970-01-01T00:00:10Z", durationMs: 30000, mutedSpans: [] },
        ],
        source: { path: "/source", source: "wisprflow" as const, layout: "left-mic" as const, durationSec: 60 },
    };
    const sound = spyOn(opened, "sound").mockResolvedValue(meetingSound({ ...base, tracks: "best" }));
    const meeting = spyOn(opened, "meeting").mockResolvedValue({
        sourceMeetingId: "fixture",
        title: "Seat",
        start: record.start,
        participants: [],
        speakers: [],
        folders: [],
        transcript: [{ startSec: 15, text: "On the microphone.", speaker: "Speaker 1" }],
    });
    const evidence = spyOn(opened, "evidence").mockResolvedValue({
        segments: [{ channel: "mic", startSec: 15, endSec: 20 }],
        speaking: [],
        files: [],
    });
    const energy = spyOn(opened, "energy").mockResolvedValue({});
    try {
        expect(await playbackSlice({ opened, atSec: 15, fromSec: 15, toSec: 20 })).toMatchObject({
            track: "mic-raw",
            fileFromSec: 5,
            fileToSec: 10,
        });
        sound.mockResolvedValue(meetingSound({ ...base, tracks: "source" }));
        expect(await playbackSlice({ opened, atSec: 15, fromSec: 15, toSec: 20 })).toMatchObject({
            track: "source-mic",
            fileFromSec: 15,
            fileToSec: 20,
            channel: 0,
        });
    } finally {
        sound.mockRestore();
        meeting.mockRestore();
        evidence.mockRestore();
        energy.mockRestore();
    }
});

test("sample playback feeds the Moment player the selected channel and seconds at 48 kHz, never the model's 16 kHz", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Native rate", start: "2026-11-01T10:00:00Z", createdBy: "new" },
        { command: "new", change: "fixture" }
    );
    const audio = join(store.folder(record.id), "native.wav"),
        captured = join(store.folder(record.id), "player.wav");
    const dataBytes = 48000 * 4 * 2;
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataBytes, 40);
    for (let frame = 0; frame < 48000 * 2; frame++) {
        wav.writeInt16LE(1000, 44 + frame * 4);
        wav.writeInt16LE(2000, 46 + frame * 4);
    }
    writeFileSync(audio, wav);
    const available = spyOn(PLAYERS.afplay, "available").mockReturnValue(true);
    // The player is replaced by a stdin capture process. No audio device is opened.
    const player = spyOn(PLAYERS.afplay, "clipArgv").mockReturnValue([
        "bun",
        "-e",
        "await Bun.write(process.argv[1], await Bun.stdin.arrayBuffer())",
        captured,
    ]);
    try {
        await playSoundSlice({
            player: "afplay",
            slice: { track: "source-call", path: audio, channel: 1, fileFromSec: 0.5, fileToSec: 1.5, clock: "source" },
        });
        const received = readFileSync(captured);
        expect(received.readUInt32LE(24)).toBe(48000);
        expect(received.readUInt16LE(22)).toBe(1);
        const data = received.indexOf(Buffer.from("data")) + 8;
        expect(received.length - data).toBe(48000 * 2);
        expect(received.readInt16LE(data)).toBe(2000);
        expect(player).toHaveBeenCalledWith("/dev/stdin");
    } finally {
        available.mockRestore();
        player.mockRestore();
    }
});

test("suggest updates one terminal spinner and keeps piped and JSON results quiet", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Voice progress", start: "2026-01-01T10:00:00Z", createdBy: "new", project: "fixture" },
        { command: "test", change: "CLI voice progress fixture" }
    );
    const suggest = await import("./suggest-run");
    const run = spyOn(suggest, "runSuggest").mockImplementation(async ({ onProgress }) => {
        for (const done of [0, 1, 2]) {
            onProgress?.(done, 2);
        }
        return { fresh: [], warnings: [], retired: [] };
    });
    const messages: string[] = [];
    const spinner = spyOn(p, "spinner").mockReturnValue({
        start: (label) => messages.push(`start ${label}`),
        message: (label) => messages.push(`update ${label}`),
        stop: (label) => messages.push(`stop ${label}`),
    });
    const json = spyOn(out, "result").mockImplementation(() => {});
    const warning = spyOn(ui, "warn").mockImplementation(() => {});
    const stdoutTTY = process.stdout.isTTY;
    const stderrTTY = process.stderr.isTTY;
    try {
        for (const mode of ["tty", "pipe", "json"]) {
            Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: mode !== "pipe" });
            Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: mode !== "pipe" });
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "suggest" });
            const args = ["suggest", record.id, "--rules", "speakers"];
            if (mode === "json") {
                args.push("--json");
            }
            await program.parseAsync(args, { from: "user" });
        }
        expect(spinner).toHaveBeenCalledTimes(1);
        expect(messages).toEqual([
            "start Voices: 0 of 2 lines",
            "update Voices: 1 of 2 lines",
            "update Voices: 2 of 2 lines",
            "stop Voices: 2 of 2 lines",
        ]);
        expect(json).toHaveBeenCalledWith("[]");
        const hint = `Seats are not set, so voice naming is off. Run: tools meetings seats ${record.id} --apply`;
        expect(warning.mock.calls.filter(([message]) => message === hint)).toHaveLength(3);
        expect(store.read(record.id)?.seats).toBeUndefined();
        await store.update(record.id, { command: "test", change: "seat the recorder" }, (current) => {
            current.seats = { room: ["Wren"], remote: [] };
        });
        warning.mockClear();
        const seated = new Command().exitOverride();
        await registerRequestedTrees({ program: seated, registrars: MEETINGS_REGISTRARS, requested: "suggest" });
        await seated.parseAsync(["suggest", record.id, "--json"], { from: "user" });
        expect(warning).not.toHaveBeenCalledWith(hint);
    } finally {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutTTY });
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: stderrTTY });
        json.mockRestore();
        warning.mockRestore();
        spinner.mockRestore();
        run.mockRestore();
    }
});

test("seats JSON previews, applies once, omits unsure people and replaces only by request", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Seat preview",
            start: "2026-01-01T12:00:00Z",
            createdBy: "new",
            participants: [
                { name: "Reed", self: true, from: [] },
                { name: "Lake Finch", from: ["platform-roster"] },
            ],
            evidence: { indicator: [{ tSec: 1, speaking: [], muted: ["Lake Finch"] }] },
        },
        { command: "test", change: "seats fixture" }
    );
    const before = readFileSync(store.path(record.id));
    const printed = spyOn(out, "result").mockImplementation(() => {});
    async function run(...flags: string[]) {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "seats" });
        printed.mockClear();
        await program.parseAsync(["seats", record.id, "--json", ...flags], { from: "user" });
        expect(printed).toHaveBeenCalledTimes(1);
        return SafeJSON.parse(String(printed.mock.calls[0]?.[0]), { strict: true });
    }
    try {
        const suggestion = {
            seats: { room: ["Reed"], remote: [] },
            people: [
                { name: "Reed", seat: "room", reason: "Recording participant (self).", confidence: 1 },
                {
                    name: "Lake Finch",
                    seat: "unsure",
                    reason: "Muted on the only roster read while present.",
                    confidence: 0,
                },
            ],
        };
        expect(await run()).toEqual({
            meeting: record.id,
            current: null,
            suggestion,
            saved: false,
            unresolved: [
                {
                    name: "Lake Finch",
                    room: `tools meetings seats ${record.id} --apply --room 'Lake Finch'`,
                    remote: `tools meetings seats ${record.id} --apply --remote 'Lake Finch'`,
                },
            ],
        });
        expect(readFileSync(store.path(record.id))).toEqual(before);
        expect(await run("--apply")).toMatchObject({ saved: true });
        expect(new MeetingStore().read(record.id)?.seats).toEqual(suggestion.seats);
        const applied = readFileSync(store.path(record.id));
        expect(await run("--apply", "--remote", "Reed")).toMatchObject({ current: suggestion.seats, saved: false });
        expect(readFileSync(store.path(record.id))).toEqual(applied);
        // Another user could save after the preview. The write checks the latest record under its lock.
        await expect(
            new DecisionJournal({ store }).apply({
                meeting: record.id,
                actor: { kind: "cli" },
                action: { kind: "set", seatsIfAbsent: true, seats: { room: [], remote: [{ name: "Reed" }] } },
            })
        ).rejects.toThrow("Seats are already set");
        expect(readFileSync(store.path(record.id))).toEqual(applied);
        expect(await run("--replace", "--room", "Lake Finch", "--remote", "Reed")).toMatchObject({
            saved: true,
            unresolved: [],
        });
        expect(new MeetingStore().read(record.id)?.seats).toEqual({ room: ["Lake Finch"], remote: [{ name: "Reed" }] });
    } finally {
        printed.mockRestore();
    }
});

test("service comment refusals keep their code in human and JSON errors", () => {
    const error = new MeetingsServiceError("already-read", "The receiver acknowledged it.");
    expect(errorText(error)).toBe("[already-read] The receiver acknowledged it.");
    expect(SafeJSON.parse(errorJSON(error), { strict: true })).toMatchObject({
        error: { data: { code: "already-read" } },
    });
});

test("decision reach preserves a dictionary addition for the window", () => {
    const reach = {
        items: [],
        dictionary: [
            { project: "demo", heard: "flimbit", fixed: "Flimbit", seenBefore: 0, teaches: false, adds: true as const },
        ],
    };
    expect(decisionReachSchema.parse(reach)).toEqual(reach);
});

describe("show sound tracks", () => {
    async function show(id: string): Promise<string> {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "show" });
        const printed = spyOn(out, "print").mockImplementation(() => {});
        try {
            await program.parseAsync(["show", id], { from: "user" });
            return printed.mock.calls.map(([text]) => text).join("\n");
        } finally {
            printed.mockRestore();
        }
    }

    test("show names recorder tracks and their saved clock without decoding audio", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            { title: "Track inventory", start: "2026-11-01T10:00:00Z", createdBy: "new" },
            { command: "new", change: "fixture" }
        );
        soundModule.appendAudioRow(store.folder(record.id), {
            file: "audio/mic.m4a",
            source: "mic",
            at: record.start,
            durationMs: 30000,
            mutedSpans: [],
        });
        soundModule.saveSoundClock(store.folder(record.id), {
            version: 1,
            sources: { mic: { correctionSec: 0.1, pieces: 1, clear: 1 } },
        });
        expect(await show(record.id)).toContain("mic-raw (measured)");
    });

    test("both channels held only by the linked app come from one provider read per call", async () => {
        const store = new MeetingStore();
        const record = await store.create(
            {
                title: "Linked sound",
                start: "2026-11-09T10:00:00Z",
                createdBy: "new",
                sources: { wisprflow: { meetingId: "linked-sound" } },
            },
            { command: "test", change: "link fixture" }
        );
        const audioPath = join(store.root, "linked-sound.ogg");
        writeFileSync(audioPath, "source bytes");
        const evidence = spyOn(wisprflowSource, "evidence").mockResolvedValue({
            audioPath,
            segments: [],
            speaking: [],
            files: [],
        });
        const transcript = spyOn(wisprflowSource, "load").mockRejectedValue(new Error("unexpected transcript read"));
        const clock = spyOn(wisprflowSource, "recordingClock").mockResolvedValue(null);
        try {
            const first = await show(record.id);
            expect(first).toContain("- source-mic (source) from linked source app (wisprflow)");
            expect(first).toContain("- source-call (source) from linked source app (wisprflow)");
            expect(first).not.toContain("mic-raw");
            expect(evidence).toHaveBeenCalledTimes(1);
            expect(evidence).toHaveBeenCalledWith("linked-sound");

            evidence.mockResolvedValue(null);
            const second = await show(record.id);
            expect(second).toContain(record.id);
            expect(second).not.toContain("## Sound tracks");
            expect(evidence).toHaveBeenCalledTimes(2);
            expect(transcript).not.toHaveBeenCalled();
            expect(clock).not.toHaveBeenCalled();
        } finally {
            evidence.mockRestore();
            transcript.mockRestore();
            clock.mockRestore();
        }
    });

    test("the record owns its preserved source channels and its recorder tracks", async () => {
        const store = new MeetingStore();
        const ref = { sourceId: "wisprflow", sourceMeetingId: "owned-sound" };
        const record = await store.create(
            {
                title: "Owned sound",
                start: "2026-11-09T11:00:00Z",
                createdBy: "new",
                sources: { wisprflow: { meetingId: ref.sourceMeetingId } },
            },
            { command: "test", change: "link fixture" }
        );
        const sourcePath = join(store.root, "owned-sound.ogg");
        writeFileSync(sourcePath, "owned bytes");
        await preserveSourceAudio({ store, meetingId: record.id, ref, sourcePath });
        const folder = store.folder(record.id);
        mkdirSync(join(folder, "audio"), { recursive: true });
        for (const source of ["mic", "system"] as const) {
            const file = `audio/${source}.m4a`;
            writeFileSync(join(folder, file), "recorder bytes");
            appendAudioRow(folder, { file, source, at: record.start, durationMs: 1000, mutedSpans: [] });
        }

        const evidence = spyOn(wisprflowSource, "evidence").mockRejectedValue(new Error("source offline"));
        try {
            const text = await show(record.id);
            expect(text).toContain("- source-mic (source) from this record");
            expect(text).toContain("- source-call (source) from this record");
            expect(text).toContain("- mic-raw (stamp) from this record");
            expect(text).toContain("- system (stamp) from this record");
            expect(text.match(/\bmic-raw\b/g)).toHaveLength(1);
            expect(text).toContain("source audio (wisprflow): preserved");
            expect(evidence).not.toHaveBeenCalled();
        } finally {
            evidence.mockRestore();
        }
    });
});

test("listen --spot-check prepares through the Meetings service, which caps the sample count", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Quality round", start: "2026-11-09T10:00:00Z", createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const human = spyOn(ui, "err").mockImplementation(() => {});
    const raw = spyOn(ui, "raw").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
        await program.parseAsync(["listen", record.id, "--spot-check", "600", "--prepare-only"], { from: "user" });
        expect(process.exitCode).toBe(1);
        expect(String(human.mock.calls.at(-1)?.[0])).toContain("500");
        expect(store.read(record.id)?.items).toEqual([]);
    } finally {
        human.mockRestore();
        raw.mockRestore();
        process.exitCode = 0;
    }
});

test("a fresh spot check selects only its sampled lines even with an older round open", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Sample selection",
            start: "2026-11-09T10:00:00Z",
            createdBy: "new",
            sources: { wisprflow: { meetingId: "sample-selection" } },
        },
        { command: "test", change: "fixture" }
    );
    const base = { status: "suggested" as const, rules: [], suggestedAt: record.start };
    await store.update(record.id, { command: "test", change: "prior round" }, (current) => {
        current.items.push(
            {
                ...base,
                id: "i1",
                kind: "question",
                group: "spot-check",
                about: "speaker",
                fromSec: 60,
                toSec: 60,
                question: "Who?",
                choices: ["River Example"],
                decides: [],
            },
            {
                ...base,
                id: "i2",
                kind: "speaker-range",
                label: "Remote",
                speaker: "River Example",
                fromSec: 2,
                toSec: 2,
                confidence: 0.63,
            }
        );
    });
    const source = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue({
        sourceMeetingId: "sample-selection",
        title: record.title,
        start: record.start,
        speakers: [],
        participants: [],
        folders: [],
        transcript: [{ speaker: "Remote", startSec: 2, text: "We can begin." }],
    });
    const output = spyOn(out, "result").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
        await program.parseAsync(["listen", record.id, "--spot-check", "1", "--prepare-only"], { from: "user" });
        const sampled = new MeetingStore(store.storage)
            .read(record.id)!
            .items.find((item) => item.kind === "question" && item.group === "spot-check" && item.fromSec === 2);
        expect(sampled).toBeDefined();
        expect(SafeJSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
            meeting: record.id,
            questions: [sampled!.id],
        });
    } finally {
        source.mockRestore();
        output.mockRestore();
    }
});

test("rows prints the threshold mark on a human-readable speaker row", async () => {
    const store = new MeetingStore();
    const start = "2026-11-09T10:00:00Z";
    const items = [0.69, 0.7].map((confidence, index) => ({
        kind: "speaker-range" as const,
        id: `i${index + 1}`,
        status: "suggested" as const,
        label: "Voice",
        speaker: "River Example",
        fromSec: index,
        toSec: index,
        confidence,
        rules: [],
        suggestedAt: start,
    }));
    const record = await store.create(
        { title: "Threshold rows", start, createdBy: "new", items },
        { command: "test", change: "fixture" }
    );
    const output = spyOn(out, "println").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "rows" });
        await program.parseAsync(["rows", record.id, "--apply-above", "70"], { from: "user" });
        const lines = output.mock.calls.map(([text]) => String(text));
        expect(lines.find((text) => text.includes("i1"))).toContain("guess 69 %");
        expect(lines.find((text) => text.includes("i2"))).toContain("suggested");
    } finally {
        output.mockRestore();
    }
});

test("listen filters previously prepared stretches against the requested apply threshold", async () => {
    const store = new MeetingStore();
    const items = [0.5, 0.7, 0.9].map((confidence, index) => ({
        kind: "question" as const,
        id: `i${index + 1}`,
        status: "suggested" as const,
        group: "long-stretch" as const,
        about: "speaker" as const,
        fromSec: index,
        toSec: index,
        confidence,
        question: "Who speaks?",
        choices: ["River Example"],
        decides: [],
        rules: [],
        suggestedAt: "2026-11-09T10:00:00Z",
    }));
    const record = await store.create(
        { title: "Prepared stretches", start: items[0]!.suggestedAt, createdBy: "new", items },
        { command: "test", change: "fixture" }
    );
    const output = spyOn(out, "result").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
        await program.parseAsync(
            ["listen", record.id, "--group", "long-stretch", "--apply-above", "70", "--prepare-only"],
            { from: "user" }
        );
        expect(SafeJSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
            meeting: record.id,
            questions: ["i1"],
        });
    } finally {
        output.mockRestore();
    }
});

test("standalone subscription flags fail before resolving or reading a meeting", async () => {
    const raw = spyOn(ui, "raw").mockImplementation(() => {});
    const human = spyOn(ui, "err").mockImplementation(() => {});
    const resolve = spyOn(MeetingStore.prototype, "resolve");
    try {
        for (const flag of ["--with-comments", "--from-start", "--follow"]) {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
            await program.parseAsync(["listen", "missing", flag], { from: "user" });
            expect(process.exitCode).toBe(1);
            expect(human).toHaveBeenLastCalledWith(
                "--with-comments, --from-start and --follow require --subscribe-answers."
            );
        }
        expect(resolve).not.toHaveBeenCalled();
    } finally {
        raw.mockRestore();
        human.mockRestore();
        resolve.mockRestore();
        process.exitCode = 0;
    }
});

test("saved clips reject playback and read-only flags before touching the meeting", async () => {
    const raw = spyOn(ui, "raw").mockImplementation(() => {});
    const human = spyOn(ui, "err").mockImplementation(() => {});
    const resolve = spyOn(MeetingStore.prototype, "resolve");
    try {
        for (const flag of ["--clip", "--no-start", "--window"]) {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "play" });
            await program.parseAsync(["play", "missing", "--at", "10", "--save", flag], { from: "user" });
            expect(human).toHaveBeenLastCalledWith(
                "--save keeps a clip without playing it; omit --clip, --no-start, --window and --player."
            );
        }
        expect(resolve).not.toHaveBeenCalled();
    } finally {
        raw.mockRestore();
        human.mockRestore();
        resolve.mockRestore();
        process.exitCode = 0;
    }
});

test("--clip --no-start plans once without cutting, saving or starting a player", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Plan only", start: "2026-11-09T10:00:00Z", end: "2026-11-09T10:02:00Z", createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const planned = {
        ...planMoment({
            record,
            transcript: [],
            listen: meetingsConfigSchema.parse({}).global.playback.listen,
            target: { kind: "range", fromSec: 2, toSec: 4 },
        }),
        audioPath: "/fixture/audio.wav",
    };
    const plan = spyOn(momentHandlers, "planMomentCall").mockResolvedValue({ moment: planned });
    const cut = spyOn(momentHandlers, "clipMomentCall").mockRejectedValue(new Error("must not cut"));
    const save = spyOn(momentHandlers, "saveMomentCall").mockRejectedValue(new Error("must not save"));
    const printed = spyOn(out, "result").mockImplementation(() => {});
    const error = spyOn(ui, "err").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "play" });
        await program.parseAsync(
            ["play", record.id, "--target", '{"kind":"range","fromSec":2,"toSec":4}', "--clip", "--no-start", "--json"],
            { from: "user" }
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect(cut).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(printed).toHaveBeenCalledWith(SafeJSON.stringify(planned, null, 2));
        expect(existsSync(join(store.folder(record.id), "moments"))).toBe(false);
    } finally {
        plan.mockRestore();
        cut.mockRestore();
        save.mockRestore();
        printed.mockRestore();
        error.mockRestore();
        process.exitCode = 0;
    }
});

test("evidence refuses the voice flags for an output that cannot show them, before it opens the recording", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Voices", start: "2026-11-09T10:00:00Z", createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const human = spyOn(ui, "err").mockImplementation(() => {});
    const raw = spyOn(ui, "raw").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "evidence" });
        await program.parseAsync(["evidence", record.id, "--voices", "3"], { from: "user" });
        expect(process.exitCode).toBe(1);
        expect(String(human.mock.calls.at(-1)?.[0])).toContain("--voices and --voice-features print with");
    } finally {
        human.mockRestore();
        raw.mockRestore();
        process.exitCode = 0;
    }
});

test("items reject by a filter that matches nothing succeeds and writes no journal entry", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Filter", start: "2026-11-09T10:00:00Z", createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const results: unknown[] = [];
    const result = spyOn(out, "result").mockImplementation((data: unknown) => {
        results.push(data);
    });
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "reject" });
        await program.parseAsync(["reject", record.id, "--kind", "term", "--json"], { from: "user" });
        expect(process.exitCode ?? 0).toBe(0);
        expect(results.map((data) => SafeJSON.parse(String(data)))).toEqual([{ decided: [], skipped: [] }]);
        expect(existsSync(join(store.folder(record.id), "decisions.ndjson"))).toBe(false);
    } finally {
        result.mockRestore();
        process.exitCode = 0;
    }
});

test("items reject takes --kind and --json although its parent items command has them too", async () => {
    const store = new MeetingStore();
    const suggested = { status: "suggested" as const, suggestedAt: "2026-11-09T10:00:00Z", rules: [] };
    const record = await store.create(
        {
            title: "Kinds",
            start: "2026-11-09T10:00:00Z",
            createdBy: "new",
            items: [
                { id: "i1", kind: "term", heard: "category data", ...suggested },
                {
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 2",
                    fromSec: 0,
                    toSec: 5,
                    speaker: "Dana Example",
                    candidates: ["Dana Example"],
                    confidence: 0.8,
                    ...suggested,
                },
            ],
        },
        { command: "test", change: "fixture" }
    );
    const results: unknown[] = [];
    const result = spyOn(out, "result").mockImplementation((data: unknown) => {
        results.push(data);
    });
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "items" });
        await program.parseAsync(["items", "reject", record.id, "--kind", "term", "--json"], { from: "user" });
        expect(process.exitCode ?? 0).toBe(0);
        // The filter travels with the reject, so the journal checks it again under its lock like the service path.
        expect(results.map((data) => SafeJSON.parse(String(data)))).toEqual([
            expect.objectContaining({
                decided: ["i1"],
                entry: expect.objectContaining({
                    action: { kind: "reject", items: ["i1"], filter: { kind: "term" } },
                }),
            }),
        ]);
        expect(store.read(record.id)?.items.map((item) => item.status)).toEqual(["rejected", "suggested"]);
    } finally {
        result.mockRestore();
        process.exitCode = 0;
    }
});

test("the items column keeps a long quote's source inside its width", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Quote",
            start: "2026-11-09T10:00:00Z",
            createdBy: "new",
            items: [
                {
                    id: "i1",
                    kind: "term",
                    status: "suggested",
                    suggestedAt: "2026-11-09T10:00:00Z",
                    rules: [],
                    heard: "category data",
                    quote: { text: `categoryData: ${"string | number | ".repeat(8)}null`, source: "dto.ts:12" },
                },
            ],
        },
        { command: "test", change: "fixture" }
    );
    const printed: string[] = [];
    const output = spyOn(out, "println").mockImplementation((text: string) => {
        printed.push(text);
    });
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "items" });
        await program.parseAsync(["items", record.id], { from: "user" });
        expect(printed.join("\n")).toContain('…" (quote from dto.ts:12)');
    } finally {
        output.mockRestore();
        process.exitCode = 0;
    }
});

test("screen-note --json reports frames whose OCR is still pending as a JSON result", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Pending OCR", start: "2026-11-09T10:00:00Z", createdBy: "record" },
        { command: "test", change: "fixture" }
    );
    const folder = store.folder(record.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, FRAME_INDEX_FILE),
        `${SafeJSON.stringify({ file: "frames/0.png", at: "2026-11-09T10:00:00.000Z", displayId: 1 }, { jsonl: true })}\n`
    );
    const results: unknown[] = [];
    const result = spyOn(out, "result").mockImplementation((data: unknown) => {
        results.push(data);
    });
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "screen-note" });
        await program.parseAsync(["screen-note", record.id, "--json"], { from: "user" });
        expect(results.map((data) => SafeJSON.parse(String(data)))).toEqual([
            { meeting: record.id, state: "ocr-pending", pending: expect.any(Number) },
        ]);
    } finally {
        result.mockRestore();
        process.exitCode = 0;
    }
});

test("screen --timeline --frame and --all print unchanged OCR lines as requested", async () => {
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Screen lines", start: "2026-11-09T10:00:00Z", createdBy: "record" },
        { command: "test", change: "fixture" }
    );
    const folder = store.folder(record.id);
    mkdirSync(join(folder, "frames"), { recursive: true });
    const image = createCanvas(400, 200).toBuffer("image/png");
    const rows = ["Old item", "New item"].map((text, index) => ({
        file: `frames/${index}.png`,
        at: `2026-11-09T10:00:0${index}.000Z`,
        displayId: 1,
        text: `Agenda\n${text}`,
        blocks: ["Agenda", text].map((text, i) => ({
            text,
            confidence: 1,
            bounds: { x: 0.1, y: 0.8 - i * 0.3, width: 0.6, height: 0.1 },
        })),
    }));
    for (const row of rows) {
        writeFileSync(join(folder, row.file), image);
    }
    writeFileSync(join(folder, "ocr.jsonl"), `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    const printed: string[] = [];
    const output = spyOn(out, "println").mockImplementation((text: string) => {
        printed.push(text);
    });
    try {
        for (const flags of [["--frame", "frames/1.png"], ["--all"]]) {
            printed.length = 0;
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "screen" });
            await program.parseAsync(["screen", record.id, "--timeline", ...flags], { from: "user" });
            expect(printed.filter((line) => line === "    Agenda")).toHaveLength(flags[0] === "--all" ? 2 : 1);
            expect(printed).toContain("    New item");
        }
    } finally {
        output.mockRestore();
        process.exitCode = 0;
    }
});

test("reopen --token with no items undoes a speaker rename; without a token it still needs the items", async () => {
    // The command reads the default store, which the test preload keeps in a sandbox.
    const store = new MeetingStore();
    const created = await store.create(
        { title: "Harbor sync", start: "2026-11-05T10:00:00.000Z", createdBy: "new", speakers: { labels: {} } },
        { command: "test", change: "fixture" }
    );
    const renamed = await new DecisionJournal({ store }).apply({
        meeting: created.id,
        action: { kind: "rename", label: "S1", name: "Dana Example" },
        actor: { kind: "cli" },
    });
    expect(store.read(created.id)?.speakers.labels).toEqual({ S1: "Dana Example" });

    const printed: string[] = [];
    const errors: string[] = [];
    const result = spyOn(out, "result").mockImplementation((text: string) => {
        printed.push(text);
    });
    const err = spyOn(ui, "err").mockImplementation((line: string) => {
        errors.push(line);
    });

    try {
        const run = async (...args: string[]) => {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "reopen" });
            await program.parseAsync(args, { from: "user" });
        };

        await run("reopen", created.id);
        expect(errors).toEqual(["Name the items to reopen, or pass --token to undo a whole decision."]);

        await run("reopen", created.id, "--token", renamed.entry!.token, "--json");
    } finally {
        result.mockRestore();
        err.mockRestore();
        process.exitCode = 0;
    }

    expect(errors).toHaveLength(1);
    expect(store.read(created.id)?.speakers.labels).toEqual({});
    expect(SafeJSON.parse(printed[0]!)).toMatchObject({
        entry: { action: { kind: "revert", token: renamed.entry!.token }, labels: [{ label: "S1" }] },
    });
});

const failureRecordSchema = z.object({
    error: z.object({
        message: z.string(),
        stack: z.string(),
        issue: z.object({ tool: z.string(), title: z.string().optional() }),
    }),
});

test("a CLI failure emits its original stack and issue as redacted JSON on stderr", () => {
    const raw = spyOn(ui, "raw").mockImplementation(() => {});
    const human = spyOn(ui, "err").mockImplementation(() => {});
    const error = Object.assign(new Error("refused"), { issue: { title: "Original refusal" } });
    error.stack =
        "Error: refused\n    at originalThrow (/fixture/source.ts:12:3) sk-ant-abcdefghijklmnopqrstuvwxyz0123";
    try {
        fail(error);
        expect(process.exitCode).toBe(1);
        expect(human).toHaveBeenCalledWith("refused");
        expect(raw).toHaveBeenCalledTimes(1);
        const record = failureRecordSchema.parse(SafeJSON.parse(raw.mock.calls[0][0]));
        expect(record.error.message).toBe("refused");
        expect(record.error.stack).toContain("at originalThrow (/fixture/source.ts:12:3)");
        expect(record.error.stack).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
        expect(record.error.issue).toEqual({ tool: "meetings", title: "Original refusal" });
        raw.mockClear();
        fail(new Error("Context: refused", { cause: error }));
        const contextual = failureRecordSchema.parse(SafeJSON.parse(raw.mock.calls[0][0]));
        expect(contextual.error.message).toBe("Context: refused");
        expect(contextual.error.stack).toBe(record.error.stack);
        expect(contextual.error.issue).toEqual(record.error.issue);
    } finally {
        raw.mockRestore();
        human.mockRestore();
        process.exitCode = 0;
    }
});

describe("enum refusals print a command that runs", () => {
    const argv = process.argv;

    afterEach(() => {
        process.argv = argv;
    });

    function typed(...args: string[]): void {
        process.argv = ["bun", "meetings", ...args];
    }

    test("a flag value keeps the subcommand and the meeting", () => {
        typed("items", "m1", "--status", "bogus");
        const hint = enumHint({
            flag: "--status",
            values: ["suggested", "confirmed"],
            subcommand: ["items"],
            given: "bogus",
        });

        expect(hint).toBe(
            '--status does not accept "bogus". Possible: suggested, confirmed\ntools meetings items m1 --status suggested'
        );
    });

    test("a two-word subcommand keeps both words", () => {
        typed("dictionary", "add", "foo", "--type", "bogus");
        const hint = enumHint({
            flag: "--type",
            values: ["fix", "abbr"],
            subcommand: ["dictionary", "add"],
            given: "bogus",
        });

        expect(hint.split("\n")[1]).toBe("tools meetings dictionary add foo --type fix");
    });

    test("a positional value is replaced in place", () => {
        typed("dictionary", "expansion", "bogus", "--project", "work");
        const hint = enumHint({
            flag: "<mode>",
            values: ["every", "first", "off"],
            subcommand: ["dictionary", "expansion"],
            given: "bogus",
        });

        expect(hint.split("\n")[1]).toBe("tools meetings dictionary expansion --project work every");
    });
});

/**
 * A command loads only its own module (startup). A registrar whose command is renamed, or an alias added without a
 * table entry, would silently fall back to loading every tree: the old 320 ms, with nothing to see.
 */
describe("MEETINGS_REGISTRARS", () => {
    test("every entry names exactly the commands its registrar adds", async () => {
        for (const entry of MEETINGS_REGISTRARS) {
            const program = new Command();
            (await entry.load())(program);
            const added = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

            expect(added.sort()).toEqual([...entry.names].sort());
        }
    });

    test("no name is claimed twice", () => {
        const names = MEETINGS_REGISTRARS.flatMap((entry) => entry.names);

        expect(names.length).toBe(new Set(names).size);
    });

    test("config registers config alone", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "config" });

        expect(program.commands.map((command) => command.name())).toEqual(["config"]);
    });

    test("help and an unknown command register every tree, in the help order", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: undefined });
        const registered = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

        expect(registered).toEqual(MEETINGS_REGISTRARS.flatMap((entry) => entry.names));
    });
});

/** MP3: @napi-rs/canvas loads the system fonts at import (about 100 ms), so only drawing boxes may load it. */
describe("startup imports", () => {
    test("the record and screen commands load no canvas until a box is drawn", async () => {
        const probe = [
            'const has = () => Object.keys(require.cache).some((key) => key.includes("@napi-rs/canvas"));',
            'await import("./src/meetings/commands/record.ts");',
            "const before = has();",
            // The positive control: since src/utils/image/canvas.ts became the one loader, the addon loads when a
            // drawing call asks for it, not when a drawing module is imported.
            'await (await import("@genesiscz/utils/image/canvas")).loadCanvas();',
            "console.log(JSON.stringify({ before, after: has() }));",
        ].join("\n");
        const child = Bun.spawn(["bun", "-e", probe], {
            cwd: join(moduleDir(import.meta), "..", "..", ".."),
            env: process.env,
            stdout: "pipe",
        });
        const output = await new Response(child.stdout).text();
        await child.exited;

        expect(output.trim()).toBe(`{"before":false,"after":true}`);
    });
});

/** MU5 and MC22: the window starts ffplay through `play --player ffplay --json`; an agent resolves without sound. */
describe("play: the player and the plan", () => {
    test("--player names the one player, and a missing one is refused rather than replaced", () => {
        const ffplay = spyOn(PLAYERS.ffplay, "available").mockReturnValue(false);
        const vlc = spyOn(PLAYERS.vlc, "available").mockReturnValue(true);

        try {
            expect(choosePlayer({ requested: "ffplay", configured: "vlc", all: ["vlc", "ffplay"] })).toEqual({
                error: "ffplay is not installed on this Mac.",
            });
            expect(choosePlayer({ requested: "mpv", configured: "vlc", all: ["vlc", "ffplay"] })).toEqual({
                error: "--player mpv is not a player: vlc, ffplay",
            });
            ffplay.mockReturnValue(true);
            expect(choosePlayer({ requested: "ffplay", configured: "vlc", all: ["vlc", "ffplay"] })).toEqual({
                player: PLAYERS.ffplay,
            });
        } finally {
            ffplay.mockRestore();
            vlc.mockRestore();
        }
    });

    test("without --player the configured one plays, else the first installed", () => {
        const ffplay = spyOn(PLAYERS.ffplay, "available").mockReturnValue(true);
        const vlc = spyOn(PLAYERS.vlc, "available").mockReturnValue(false);

        try {
            expect(choosePlayer({ configured: "vlc", all: ["vlc", "ffplay"] })).toEqual({ player: PLAYERS.ffplay });
        } finally {
            ffplay.mockRestore();
            vlc.mockRestore();
        }
    });

    test("ffplay starts at the asked second with no window, and never before second 0", () => {
        const plan = playbackPlan({ audioPath: "/a/upload.ogg", atSec: 30, beforeSec: 5, player: PLAYERS.ffplay });

        expect(plan).toEqual({
            audioPath: "/a/upload.ogg",
            startSec: 25,
            player: "ffplay",
            argv: ["ffplay", "-ss", "25", "-nodisp", "-autoexit", "/a/upload.ogg"],
        });
        expect(playbackPlan({ audioPath: "/a/x.ogg", atSec: 2, beforeSec: 5, player: PLAYERS.vlc }).startSec).toBe(0);
    });
});

/** MU1: a recording-only meeting is a state, so the window reads a code and shows its empty state. */
describe("a meeting without a transcript source", () => {
    const recordingOnly = meetingRecordSchema.parse({
        id: "2026-11-06_10-00-screen-only",
        title: "Screen only",
        start: "2026-11-06T09:00:00.000Z",
        createdAt: "2026-11-06T09:00:00.000Z",
        createdBy: "record",
    });

    test("transcript, speakers and suggest lead their sentence with [no-transcript-source]", async () => {
        const failure = await linkedSource(recordingOnly).then(
            () => "linked",
            (err: unknown) => errorText(err)
        );

        expect(failure).toStartWith(
            "[no-transcript-source] 2026-11-06_10-00-screen-only has no source with a transcript."
        );
    });

    test("play leads with the same code", async () => {
        const failure = await meetingAudioPath(recordingOnly).then(
            () => "audio",
            (err: unknown) => errorText(err)
        );

        expect(failure).toBe("[no-transcript-source] 2026-11-06_10-00-screen-only has no linked source with audio.");
    });

    test("evidence leads with the same code", async () => {
        // The command reads the default store, which the test preload keeps in a sandbox.
        const store = new MeetingStore();
        const created = await store.create(
            { title: "Screen only", start: "2026-11-06T09:00:00.000Z", createdBy: "record" },
            { command: "test", change: "create" }
        );
        const errors: string[] = [];
        const err = spyOn(ui, "err").mockImplementation((line: string) => {
            errors.push(line);
        });
        const raw = spyOn(ui, "raw").mockImplementation(() => {});

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "evidence" });
            await program.parseAsync(["evidence", created.id], { from: "user" });
            const record = failureRecordSchema.parse(SafeJSON.parse(raw.mock.calls[0][0]));
            expect(record.error.stack).toContain("at linkedSource");
        } finally {
            raw.mockRestore();
            err.mockRestore();
            process.exitCode = 0;
        }

        expect(errors).toEqual([
            `[no-transcript-source] ${created.id} has no source with a transcript. Link one: tools meetings link ${created.id} 'wisprflow:<id>'`,
        ]);
    });

    test("suggest refuses a meeting with no project and names the command that sets it", async () => {
        const store = new MeetingStore();
        const created = await store.create(
            { title: "No project yet", start: "2026-11-06T11:00:00.000Z", createdBy: "record" },
            { command: "test", change: "create" }
        );
        const errors: string[] = [];
        const err = spyOn(ui, "err").mockImplementation((line: string) => {
            errors.push(line);
        });

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "suggest" });
            await program.parseAsync(["suggest", created.id], { from: "user" });
            expect(process.exitCode).toBe(1);
        } finally {
            err.mockRestore();
            process.exitCode = 0;
        }

        expect(errors.join("\n")).toContain("This meeting has no project.");
        expect(errors.join("\n")).toContain(`meetings set ${created.id} --project`);
        expect(store.read(created.id)?.items).toEqual([]);
    });
});

describe("--json is the short form of --format json (MC19)", () => {
    afterEach(() => {
        process.exitCode = 0;
    });

    test("--json alone asks for json, and without it --format passes through", () => {
        expect(formatFlag({ json: true })).toEqual({ format: "json" });
        expect(formatFlag({ json: true, format: "json" })).toEqual({ format: "json" });
        expect(formatFlag({ format: "table" })).toEqual({ format: "table" });
        expect(formatFlag({})).toEqual({ format: undefined });
    });

    test("--json with another --format is refused with exit 1", () => {
        expect(formatFlag({ json: true, format: "md" })).toBeUndefined();
        expect(process.exitCode).toBe(1);
    });
});

describe("play --at past the meeting's end (R2-MC5)", () => {
    test("a time more than 30 s after the last speech is refused with that speech's time; no segments means no bound", () => {
        expect(pastTheEnd(356_400, 2772)).toBe("--at 99:00:00 is after the meeting's last speech (46:12).");
        expect(pastTheEnd(2800, 2772)).toBeUndefined();
        expect(pastTheEnd(356_400, undefined)).toBeUndefined();
    });
});

describe("list --json prints one summary row per meeting, and --limit keeps the newest (R2-NR-X3)", () => {
    const at = "2026-11-05T10:00:00.000Z";
    const meeting = (id: string, start: string, project?: string) =>
        meetingRecordSchema.parse({
            id,
            title: "Planning",
            start,
            createdAt: start,
            createdBy: "new",
            ...(project ? { project } : {}),
            sources: { wisprflow: { meetingId: "w1" } },
            items: [
                { id: "i1", kind: "term", status: "suggested", atSec: 1, heard: "x", suggestedAt: at, rules: [] },
                { id: "i2", kind: "term", status: "confirmed", atSec: 2, heard: "y", suggestedAt: at, rules: [] },
            ],
            recording: { status: "stopped", frames: 12, bytes: 2048 },
        });

    test("a row holds the facts a list needs, not the items, history or recording spans", () => {
        expect(meetingListRow(meeting("a", at, "work"))).toEqual({
            id: "a",
            title: "Planning",
            start: at,
            project: "work",
            labels: [],
            sources: ["wisprflow"],
            context: 0,
            items: { suggested: 1, confirmed: 1, rejected: 0 },
            recording: { status: "stopped", frames: 12, bytes: 2048 },
        });
    });

    test("--project filters before --limit, so the limit counts that project's meetings, and reads stop there", async () => {
        const store = new MeetingStore(new Storage(`meetings-list-limit-${process.pid}`));
        const create = async (title: string, start: string, project?: string) =>
            (
                await store.create(
                    { title, start, createdBy: "new", ...(project ? { project } : {}) },
                    { command: "test", change: "fixture" }
                )
            ).id;
        const a = await create("A", "2026-11-03T10:00:00.000Z", "work");
        const b = await create("B", "2026-11-04T11:00:00.000Z", "work");
        const c = await create("C", "2026-11-05T12:00:00.000Z");
        const read = spyOn(store, "read");

        try {
            expect(selectMeetings(store, { limit: 2 }).map((one) => one.id)).toEqual([c, b]);
            expect(read).toHaveBeenCalledTimes(2);
            read.mockClear();
            expect(selectMeetings(store, { project: "work", limit: 1 }).map((one) => one.id)).toEqual([b]);
            expect(read).toHaveBeenCalledTimes(2);
            expect(selectMeetings(store, {}).map((one) => one.id)).toEqual([c, b, a]);
            read.mockClear();
            const client = new InProcessMeetingsClient({ deps: { store: () => store } });
            try {
                expect(
                    (await client.call("meetings.list", { project: "work", limit: 1, full: true })).map((one) => one.id)
                ).toEqual([b]);
                expect(read).toHaveBeenCalledTimes(2);
            } finally {
                client.close();
            }
        } finally {
            read.mockRestore();
        }
    });
});

describe("config get is config show (R2-NR-X4)", () => {
    test("config get <path> prints the value, as show does, instead of suggesting set", async () => {
        const printed: string[] = [];
        const println = spyOn(out, "println").mockImplementation((text: string) => {
            printed.push(text);
        });
        const dim = spyOn(ui, "dim").mockImplementation(() => undefined);

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "config" });
            await program.parseAsync(["config", "get", "global.capture.activeFps"], { from: "user" });
        } finally {
            println.mockRestore();
            dim.mockRestore();
        }

        expect(printed).toEqual(["1"]);
    });
});

describe("rows --json: the review rows (F3)", () => {
    const at = "2026-11-05T10:00:00.000Z";
    const question = (id: string, fields: Record<string, unknown>) => ({
        id,
        kind: "question",
        status: "suggested",
        about: "term",
        fromSec: 600,
        toSec: 604,
        choices: [],
        decides: [],
        suggestedAt: at,
        rules: [],
        ...fields,
    });
    const record = meetingRecordSchema.parse({
        id: "2026-11-05-planning",
        title: "Planning",
        start: at,
        createdAt: at,
        createdBy: "new",
        items: [
            {
                id: "i1",
                kind: "term",
                status: "suggested",
                atSec: 600,
                heard: "OMP",
                proposed: "EMP",
                confidence: 0.7,
                suggestedAt: at,
                rules: ["phonetic-term"],
                // A saved record's strings; a newer one has evidence.candidateScores.
                evidence: { candidates: ["EMP 70 %", "AMP 82 %", "OMP 40 %"], transcriptLine: 3 },
            },
            {
                id: "i2",
                kind: "speaker-range",
                status: "suggested",
                label: "Speaker 2",
                fromSec: 120,
                toSec: 180,
                speaker: "Alice Example",
                candidates: ["Alice Example", "Bob Example"],
                confidence: 0.6,
                suggestedAt: at,
                rules: [],
                evidence: { reason: "Twice (1:08:24, 1:08:55), see commit 196fbf15 and ADO 312655" },
            },
            question("i3", {
                question: 'Is "OMP" at 10:00 really "EMP"?',
                heard: "OMP",
                choices: ["EMP", "OMP"],
                decides: ["i1"],
                priority: 0.4,
            }),
            question("i4", {
                about: "speaker",
                fromSec: 120,
                toSec: 180,
                question: 'Who speaks under "Speaker 2" from 02:00 to 03:00?',
                choices: ["Alice Example", "Bob Example"],
                decides: ["i2"],
                priority: 0.9,
            }),
            question("i5", {
                question: "Was it said at 10:00 and 10:30?",
                priority: 0.1,
            }),
            question("i6", {
                status: "confirmed",
                fromSec: 30,
                toSec: 32,
                heard: "OMP",
                question: 'What is "OMP" at 00:30?',
                answer: "EMP",
                priority: 0.4,
                decidedAt: at,
                decision: {
                    token: "tok-6",
                    previous: { status: "suggested" },
                    actor: { kind: "agent", harness: "claude-code", session: "3f98b772-0000-4000-8000-000000000000" },
                    entry: { action: "answer", reason: "the calendar says so" },
                },
            }),
        ],
    });

    test("one order: questions by priority then time (a decided one keeps its place), then the rest by time; low priority is counted", async () => {
        const { reviewRows } = await import("./review-rows");
        const rows = reviewRows(record, { minPriority: 0.2 });
        const all = reviewRows(record, { minPriority: 0.2, lowPriority: "show" });

        expect(rows.rows.map((row) => row.label)).toEqual(["Q2", "Q4", "Q1", "i2", "i1"]);
        expect(rows.hidden).toEqual({ lowPriority: 1, minPriority: 0.2 });
        expect(all.rows.map((row) => row.label)).toEqual(["Q2", "Q4", "Q1", "Q3", "i2", "i1"]);
        expect(all.hidden.lowPriority).toBe(0);
    });

    test("a decided row says what it was decided as (the answer, the spelling, the speaker); an open or rejected row says nothing", async () => {
        const { reviewRow } = await import("./review-rows");
        const decided = (index: number, status: "confirmed" | "rejected") =>
            reviewRow(record, { ...record.items[index]!, status });

        expect(reviewRow(record, record.items[5]!).answer).toBe("EMP");
        expect(decided(0, "confirmed").answer).toBe("EMP");
        expect(decided(1, "confirmed").answer).toBe("Alice Example");
        expect(decided(0, "rejected").answer).toBeUndefined();
        expect(reviewRow(record, record.items[0]!).answer).toBeUndefined();
        expect(reviewRow(record, record.items[2]!).answer).toBeUndefined();
    });

    test.each(["rejected", "suggested"] as const)(
        "a %s question does not publish its retained answer",
        async (status) => {
            const { reviewRow } = await import("./review-rows");
            const question = { ...record.items[5]!, status };
            expect(question).toMatchObject({ kind: "question", answer: "EMP" });
            expect(reviewRow(record, question).answer).toBeUndefined();
            expect(question).toMatchObject({ status, answer: "EMP" });
        }
    );

    test("a question reads as parts: who, when, what it asks without the baked time, what it settles", async () => {
        const { reviewRow } = await import("./review-rows");
        const speaker = reviewRow(record, record.items[3]!);
        const agent = reviewRow(record, record.items[4]!);

        expect(speaker.parts).toEqual([
            { kind: "who", text: "Speaker 2" },
            {
                kind: "when",
                from: { sec: 120, text: "02:00" },
                to: { sec: 180, text: "03:00" },
                target: { kind: "item", id: "i4" },
            },
            { kind: "asks", pieces: [{ text: 'Who speaks under "Speaker 2"?' }] },
            { kind: "settles", text: "It settles 1 item", items: ["i2"] },
        ]);
        expect(agent.parts.find((part) => part.kind === "asks")).toEqual({
            kind: "asks",
            pieces: [
                { text: "Was it said at " },
                { text: "10:00", target: { kind: "time", atSec: 600 } },
                { text: " and " },
                { text: "10:30", target: { kind: "time", atSec: 630 } },
                { text: "?" },
            ],
        });
        expect([speaker.edit, speaker.needs, speaker.target]).toEqual(["answer", "listen", { kind: "item", id: "i4" }]);
    });

    test("a speaker question explains E1 and keeps the rule ID in the row data", async () => {
        const { reviewRow } = await import("./review-rows");
        const row = reviewRow(record, { ...record.items[3]!, rules: ["E1"] });

        expect(row.parts.filter((part) => part.kind === "reason")).toEqual([
            { kind: "reason", pieces: [{ text: "The recording separates microphone audio from call audio." }] },
        ]);
        expect(row.rules).toEqual(["E1"]);
    });

    test("every meeting rule gives the reader a reason in words", async () => {
        const { reviewRow } = await import("./review-rows");
        for (const rule of Object.values(MeetingRule)) {
            const row = reviewRow(record, { ...record.items[3]!, rules: [rule] });
            const reason = row.parts.find((part) => part.kind === "reason");
            const text = reason?.pieces.map((piece) => piece.text).join("");
            expect(text).toMatch(/\w+\s+\w+/u);
            expect(text).not.toBe(`Rules: ${rule}`);
        }
    });

    test("known rules read in order and an unrecognized saved ID remains in the row data", async () => {
        const { reviewRow } = await import("./review-rows");
        const rules = ["E3", "retired-rule", "E1"];
        const row = reviewRow(record, { ...record.items[3]!, rules });

        expect(row.parts.filter((part) => part.kind === "reason")).toEqual([
            {
                kind: "reason",
                pieces: [
                    {
                        text: "The call shows who is speaking. The recording separates microphone audio from call audio.",
                    },
                ],
            },
        ]);
        expect(row.rules).toEqual(["E3", "retired-rule", "E1"]);
    });

    test("choices are typed with confidence: highest scores first including earlier answers, then unscored actions", async () => {
        const { reviewRow } = await import("./review-rows");
        const term = reviewRow(record, record.items[2]!);
        const speaker = reviewRow(record, record.items[3]!);

        expect(term.choices.map((choice) => [choice.role, choice.value, choice.confidence])).toEqual([
            ["presumed", "AMP", 0.82],
            ["earlier", "EMP", 0.7],
            ["heard", "OMP", 0.4],
            ["none", "none of these", undefined],
            ["skip", "skip", undefined],
        ]);
        expect(term.choices[1]).toMatchObject({ hint: "as at 00:30", action: { kind: "answer", answer: "EMP" } });
        expect(speaker.choices.map((choice) => [choice.role, choice.value, choice.confidence])).toEqual([
            ["suggested", "Alice Example", 0.6],
            ["candidate", "Bob Example", undefined],
            ["none", "none of these", undefined],
            ["split", "split", undefined],
            ["skip", "skip", undefined],
        ]);
    });

    test("a word question without a candidate offers Keep as heard: None of these named nothing there", async () => {
        const { reviewRow } = await import("./review-rows");
        const bare = meetingRecordSchema.parse({
            id: "2026-11-05-bare",
            title: "Bare",
            start: at,
            createdAt: at,
            createdBy: "new",
            items: [
                question("i1", { question: 'What is "Hohem"?', heard: "Hohem" }),
                question("i2", { about: "speaker", question: 'Who speaks under "Speaker 2"?' }),
            ],
        });
        const labels = (index: number) =>
            reviewRow(bare, bare.items[index]!).choices.map((choice) => [choice.label, choice.role, choice.value]);

        expect(labels(0)).toEqual([
            ["Keep as heard", "none", "none of these"],
            ["Skip", "skip", "skip"],
        ]);
        expect(labels(1)[0]).toEqual(["None of these", "none", "none of these"]);
        expect(reviewRow(record, record.items[2]!).choices.find((choice) => choice.role === "none")?.label).toBe(
            "None of these"
        );
    });

    test("typed candidate scores win over the saved strings, best first, and a score that does not read is left out", async () => {
        const { candidateScores } = await import("./review-rows");
        const typed = structuredClone(record.items[0]!);
        typed.evidence = {
            candidates: ["EMP 70 %"],
            candidateScores: [
                { term: "AMP", confidence: 0.82 },
                { term: "EMP", confidence: 0.7, extra: true },
                { term: 3, confidence: 0.9 },
                "OMP 40 %",
            ],
        };

        expect(candidateScores(typed)).toEqual([
            { term: "AMP", confidence: 0.82 },
            { term: "EMP", confidence: 0.7 },
        ]);
        expect(candidateScores(record.items[0]!)).toEqual([
            { term: "AMP", confidence: 0.82 },
            { term: "EMP", confidence: 0.7 },
            { term: "OMP", confidence: 0.4 },
        ]);
    });

    test("a candidate score outside 0 to 1 is left out in both forms, so a row choice never carries it", async () => {
        const { candidateScores, reviewRow } = await import("./review-rows");
        const typed = structuredClone(record.items[0]!);
        typed.evidence = {
            candidateScores: [
                { term: "Example", confidence: 1.2 },
                { term: "Below", confidence: -0.1 },
                { term: "AMP", confidence: 0.82 },
            ],
        };
        const legacy = structuredClone(record.items[0]!);
        legacy.evidence = { candidates: ["Example 120 %", "AMP 82 %"] };

        expect(candidateScores(typed)).toEqual([{ term: "AMP", confidence: 0.82 }]);
        expect(candidateScores(legacy)).toEqual([{ term: "AMP", confidence: 0.82 }]);
        expect(reviewRow(record, legacy).choices.every((choice) => (choice.confidence ?? 0) <= 1)).toBe(true);
    });

    test("Wave E: a better-scoring speaker candidate precedes the suggestion without changing its action", async () => {
        const { reviewRow } = await import("./review-rows");
        const item = meetingRecordSchema.parse({
            ...record,
            items: [
                {
                    id: "i90",
                    kind: "speaker-range",
                    status: "suggested",
                    suggestedAt: at,
                    fromSec: 10,
                    toSec: 20,
                    label: "Speaker 1",
                    speaker: "Alice Example",
                    candidates: ["Alice Example", "Bob Example"],
                    confidence: 0.4,
                    evidence: {
                        candidateScores: [
                            { speaker: "Alice Example", confidence: 0.4, evidence: [] },
                            { speaker: "Bob Example", confidence: 0.9, evidence: [] },
                        ],
                    },
                },
            ],
        }).items[0]!;
        const row = reviewRow(record, item);
        expect(row.choices.map((choice) => choice.value)).toEqual(["Bob Example", "Alice Example", "none of these"]);
        expect(row.choices[0]?.action).toEqual({ kind: "confirm", speaker: "Bob Example" });
        expect(row.choices[1]?.action).toEqual({ kind: "confirm" });
    });

    test("speaker choices carry the range's typed candidate scores (G31): highest first, none without a score", async () => {
        const { reviewRow, speakerAnswerScores } = await import("./review-rows");
        const scored = (id: string, fromSec: number, scores: Array<[string, number]>) => ({
            id,
            kind: "speaker-range",
            status: "suggested",
            label: "Speaker 2",
            fromSec,
            toSec: fromSec + 30,
            speaker: "Alice Example",
            candidates: ["Alice Example", "Bob Example", "Dan Example"],
            confidence: 0.6,
            suggestedAt: at,
            rules: ["E1", "E3"],
            evidence: {
                candidateScores: scores.map(([speaker, confidence]) => ({
                    speaker,
                    confidence,
                    lines: 3,
                    evidence: [{ kind: "voice", rule: "E3", lines: 2 }],
                })),
            },
        });
        const asking = (id: string, decides: string[]) =>
            question(id, {
                about: "speaker",
                fromSec: 120,
                toSec: 180,
                question: 'Who speaks under "Speaker 2" from 02:00 to 03:00?',
                choices: ["Alice Example", "Bob Example", "Dan Example", "Eve Example"],
                decides,
                priority: 0.9,
            });
        const withScores = meetingRecordSchema.parse({
            ...record,
            items: [
                scored("i1", 120, [
                    ["Alice Example", 0.6],
                    ["Dan Example", 0.1],
                    ["Bob Example", 0.25],
                ]),
                // A later answer raised Alice to 0.9: the others keep their proportions in the 0.1 she leaves.
                {
                    ...scored("i2", 150, [
                        ["Alice Example", 0.6],
                        ["Bob Example", 0.32],
                        ["Dan Example", 0.08],
                    ]),
                    confidence: 0.9,
                },
                // Eve has a score in one range only: a cluster question shows her none.
                scored("i3", 160, [
                    ["Alice Example", 0.6],
                    ["Eve Example", 0.2],
                    ["Bob Example", 0.1],
                    ["Dan Example", 0.05],
                ]),
                asking("i4", ["i1"]),
                asking("i5", ["i1", "i2"]),
                asking("i6", ["i1", "i3"]),
            ],
        });
        const view = (index: number) =>
            reviewRow(withScores, withScores.items[index]!).choices.map((choice) => [
                choice.role,
                choice.value,
                choice.confidence,
            ]);

        expect(view(3).slice(0, 4)).toEqual([
            ["suggested", "Alice Example", 0.6],
            ["candidate", "Bob Example", 0.25],
            ["candidate", "Dan Example", 0.1],
            ["candidate", "Eve Example", undefined],
        ]);
        // Bob: min(0.25, 0.32 × 0.1 / 0.4 = 0.08); Dan: min(0.1, 0.08 × 0.1 / 0.4 = 0.02).
        expect(view(4).slice(1, 3)).toEqual([
            ["candidate", "Bob Example", 0.08],
            ["candidate", "Dan Example", 0.02],
        ]);
        expect(view(5).find((choice) => choice[1] === "Eve Example")).toEqual(["candidate", "Eve Example", undefined]);
        expect(view(0).slice(0, 3)).toEqual([
            ["suggested", "Alice Example", 0.6],
            ["candidate", "Bob Example", 0.25],
            ["candidate", "Dan Example", 0.1],
        ]);
        const asked = withScores.items.find((item) => item.id === "i4");

        if (asked?.kind !== "question") {
            throw new Error("the fixture has no question i4");
        }

        expect([...speakerAnswerScores(withScores, asked)]).toEqual([
            ["Alice Example", 0.6],
            ["Bob Example", 0.25],
            ["Dan Example", 0.1],
        ]);
    });

    test("a cluster question's suggested speaker shows the lowest score over its ranges, in either record order", async () => {
        const { reviewRow, speakerAnswerScores } = await import("./review-rows");
        const range = (id: string, fromSec: number, alice: number) => ({
            id,
            kind: "speaker-range",
            status: "suggested",
            label: "Speaker 2",
            fromSec,
            toSec: fromSec + 20,
            speaker: "Alice Example",
            candidates: ["Alice Example", "Bob Example"],
            confidence: alice,
            suggestedAt: at,
            rules: ["E3"],
            evidence: {
                candidateScores: [
                    { speaker: "Alice Example", confidence: alice, evidence: [{ kind: "voice" }] },
                    { speaker: "Bob Example", confidence: 1 - alice, evidence: [{ kind: "voice" }] },
                ],
            },
        });
        const asking = question("i9", {
            about: "speaker",
            fromSec: 120,
            toSec: 170,
            question: 'Who speaks under "Speaker 2" from 02:00 to 02:50?',
            choices: ["Alice Example", "Bob Example"],
            decides: ["i7", "i8"],
            priority: 0.9,
        });

        for (const ranges of [
            [range("i7", 120, 0.9), range("i8", 150, 0.4)],
            [range("i8", 150, 0.4), range("i7", 120, 0.9)],
        ]) {
            const withRanges = meetingRecordSchema.parse({ ...record, items: [...ranges, asking] });
            const asked = withRanges.items[2]!;

            if (asked.kind !== "question") {
                throw new Error("the fixture has no question i9");
            }

            const suggested = reviewRow(withRanges, asked).choices.find((choice) => choice.role === "suggested");
            expect([suggested?.value, suggested?.confidence]).toEqual(["Alice Example", 0.4]);
            expect(speakerAnswerScores(withRanges, asked).get("Alice Example")).toBe(0.4);
        }
    });

    test("a range row offers every person its typed scores weigh, not only its candidates", async () => {
        const { reviewRow } = await import("./review-rows");
        const item = meetingRecordSchema.parse({
            ...record,
            items: [
                {
                    id: "i90",
                    kind: "speaker-range",
                    status: "suggested",
                    suggestedAt: at,
                    fromSec: 10,
                    toSec: 20,
                    label: "Speaker 1",
                    speaker: "Bob Example",
                    confidence: 0.7,
                    evidence: {
                        candidateScores: [
                            { speaker: "Bob Example", confidence: 0.7, evidence: [{ kind: "voice" }] },
                            { speaker: "Dan Example", confidence: 0.3, evidence: [{ kind: "roster" }] },
                        ],
                    },
                },
            ],
        }).items[0]!;

        expect(reviewRow(record, item).choices.map((choice) => choice.value)).toEqual([
            "Bob Example",
            "Dan Example",
            "none of these",
        ]);
    });

    test("a removal row quotes the words it removes, and a range of one instant quotes its own line", async () => {
        const { reviewRow } = await import("./review-rows");
        const transcript = [
            { startSec: 29.7, speaker: "Speaker 1", text: "The line before." },
            { startSec: 30, speaker: "Speaker 2", text: "Okay, I will dial in now." },
            { startSec: 34, speaker: "Speaker 1", text: "The line after." },
        ];
        const withRemoval = meetingRecordSchema.parse({
            ...record,
            items: [
                {
                    id: "i91",
                    kind: "removal",
                    status: "suggested",
                    suggestedAt: at,
                    fromSec: 30,
                    toSec: 30,
                    heard: "Okay, I will dial in now.",
                    confidence: 0.9,
                    rules: ["local-speech"],
                },
                {
                    id: "i92",
                    kind: "speaker-range",
                    status: "suggested",
                    suggestedAt: at,
                    fromSec: 30,
                    toSec: 30,
                    label: "Speaker 2",
                    rules: [],
                    evidence: { endSec: 34 },
                },
            ],
        });
        const said = (index: number) =>
            reviewRow(withRemoval, withRemoval.items[index]!, transcript).parts.find((part) => part.kind === "said");

        expect(said(0)).toEqual({ kind: "said", text: "Okay, I will dial in now." });
        expect(said(1)).toEqual({ kind: "said", text: "Okay, I will dial in now." });
    });

    test("an answer that raises another question's confidence does not move that question's row (R16)", async () => {
        const { reviewRows } = await import("./review-rows");
        const speakerQuestion = (id: string, fromSec: number, confidence: number) =>
            question(id, {
                about: "speaker",
                fromSec,
                toSec: fromSec + 10,
                question: `Who speaks under "Speaker 2" at ${fromSec}?`,
                choices: ["Alice Example"],
                decides: [],
                confidence,
                evidence: { words: 100, rank: (1 - confidence) * 100 },
            });
        const asked = meetingRecordSchema.parse({
            ...record,
            items: [speakerQuestion("i93", 300, 0.5), speakerQuestion("i94", 200, 0.7)],
        });
        const order = (from: typeof asked) => reviewRows(from, { minPriority: 0 }).rows.map((row) => row.id);
        const answered = structuredClone(asked);
        const raised = answered.items[0]!;

        if (raised.kind !== "question") {
            throw new Error("the fixture has no question i93");
        }

        // What propagateAnswer does to a compatible question: its confidence rises, so its live rank falls (50 to 20).
        raised.confidence = 0.8;

        expect(order(asked)).toEqual(["i93", "i94"]);
        expect(order(answered)).toEqual(["i93", "i94"]);
    });

    test("word questions come in the window order the terminal asks them: the most heard word first", async () => {
        const { reviewRows } = await import("./review-rows");
        const { openQuestions } = await import("./questions");
        const wordQuestion = (id: string, fromSec: number, heard: string, occurrences: number) =>
            question(id, {
                about: "term",
                group: "words",
                fromSec,
                toSec: fromSec + 2,
                heard,
                question: `How is "${heard}" spelled?`,
                choices: [],
                decides: [],
                evidence: { occurrences },
            });
        const asked = meetingRecordSchema.parse({
            ...record,
            items: [wordQuestion("i95", 100, "zorbex", 2), wordQuestion("i96", 400, "quillet", 9)],
        });

        expect(openQuestions(asked).map((item) => item.id)).toEqual(["i96", "i95"]);
        expect(reviewRows(asked, { minPriority: 0 }).rows.map((row) => row.id)).toEqual(["i96", "i95"]);
    });

    test("an item row: its choices act on it, its reason is pieces and sources, and a decision names who made it", async () => {
        const { reviewRow } = await import("./review-rows");
        const term = reviewRow(record, record.items[0]!);
        const range = reviewRow(record, record.items[1]!);
        const answered = reviewRow(record, record.items[5]!);

        expect(term.choices).toEqual([
            {
                value: "AMP",
                label: "AMP",
                role: "presumed",
                action: { kind: "respell", text: "AMP" },
                confidence: 0.82,
            },
            { value: "EMP", label: "EMP", role: "suggested", action: { kind: "confirm" }, confidence: 0.7 },
            { value: "OMP", label: "Real word · keep as heard", role: "heard", action: { kind: "reject" } },
        ]);
        expect([term.edit, range.edit, term.sources]).toEqual([
            "spelling",
            "person",
            [{ kind: "line", at: { sec: 600, text: "10:00" }, line: 3 }],
        ]);
        expect(range.choices.map((choice) => [choice.role, choice.action])).toEqual([
            ["suggested", { kind: "confirm" }],
            ["candidate", { kind: "confirm", speaker: "Bob Example" }],
            ["none", { kind: "reject" }],
        ]);
        expect(range.parts.find((part) => part.kind === "reason")).toEqual({
            kind: "reason",
            pieces: [
                { text: "Twice (" },
                { text: "1:08:24", target: { kind: "time", atSec: 4104 } },
                { text: ", " },
                { text: "1:08:55", target: { kind: "time", atSec: 4135 } },
                { text: "), see " },
                { text: "commit 196fbf15", commit: "196fbf15" },
                { text: " and " },
                { text: "ADO 312655", workItem: "312655" },
            ],
        });
        expect(range.sources).toEqual([
            { kind: "commit", sha: "196fbf15" },
            { kind: "workItem", id: "312655" },
        ]);
        expect(answered.decision).toEqual({
            token: "tok-6",
            actor: { kind: "agent", harness: "claude-code", session: "3f98b772-0000-4000-8000-000000000000" },
            by: "an agent (Claude Code, session 3f98b772)",
            action: "answer",
            reason: "the calendar says so",
            at,
        });
    });
});

describe("comment commands without a service", () => {
    test("stage, send and acknowledge use the persisted comment state", async () => {
        const store = new MeetingStore();
        const meeting = await store.create(
            { title: "Comment command", start: "2026-11-02T14:00:00.000Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        const printed: string[] = [];
        const output = spyOn(out, "result").mockImplementation((value) => printed.push(String(value)));
        const errors: string[] = [];
        const failure = spyOn(ui, "err").mockImplementation((value) => errors.push(String(value)));
        const run = async (...args: string[]) => {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "comments" });
            await program.parseAsync(["comments", ...args, "--json"], { from: "user" });
        };
        try {
            await run("stage", meeting.id, "--target", '{"kind":"time","atSec":3}', "--text", "Check this word");
            await run("send", meeting.id);
            await run("read", meeting.id, "c1");
            expect(process.exitCode).toBe(1);
            expect(errors).toContain("[wrong-actor] A comment's author cannot acknowledge its own comment.");
            expect(printed).toHaveLength(2);
            process.exitCode = 0;
            const comments = MeetingComments.of(store, meeting.id);
            const foreign = comments.stage({
                target: { kind: "time", atSec: 4 },
                text: "The other caller's comment",
                actor: { kind: "agent", harness: "codex", session: "fixture-author" },
            });
            comments.markSent([foreign], { token: "fixture-foreign", at: foreign.at, actor: foreign.actor });
            await run("read", meeting.id, foreign.id);
            expect(process.exitCode).toBe(0);
            expect(printed).toHaveLength(3);
            expect(MeetingComments.of(new MeetingStore(), meeting.id).list()[0]).toMatchObject({
                id: "c1",
                state: "sent",
                text: "Check this word",
            });
            const reopened = MeetingComments.of(new MeetingStore(), meeting.id).list();
            expect(reopened[0]?.readAt).toBeUndefined();
            expect(reopened[1]).toMatchObject({ id: foreign.id, readAt: expect.any(String) });
        } finally {
            output.mockRestore();
            failure.mockRestore();
            process.exitCode = 0;
        }
    });
});

describe("listen answers without a service", () => {
    test("Wave E: decide plans without writing and applies a typed action through the fallback adapter", async () => {
        const at = "2026-11-02T14:00:00.000Z";
        const store = new MeetingStore();
        const meeting = await store.create(
            {
                title: "Decision command",
                start: at,
                createdBy: "new",
                items: [
                    {
                        id: "i1",
                        kind: "term",
                        status: "suggested",
                        heard: "Atlas",
                        proposed: "Aster",
                        confidence: 0.8,
                        rules: [],
                        suggestedAt: at,
                    },
                ],
            },
            { command: "test", change: "fixture" }
        );
        const printed: unknown[] = [];
        const output = spyOn(out, "result").mockImplementation((value) => {
            printed.push(value);
        });
        const action = SafeJSON.stringify({ kind: "respell", item: "i1", text: "Azure" });
        const execute = async (plan: boolean) => {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "decide" });
            await program.parseAsync(
                [
                    "decide",
                    meeting.id,
                    "--action",
                    action,
                    "--reason",
                    "confirmed spelling",
                    "--json",
                    ...(plan ? ["--plan"] : []),
                ],
                { from: "user" }
            );
        };
        try {
            await execute(true);
            expect(new MeetingStore().read(meeting.id)?.items[0]?.status).toBe("suggested");
            await execute(false);
            expect(new MeetingStore().read(meeting.id)?.items[0]).toMatchObject({
                status: "confirmed",
                proposed: "Azure",
                decision: { entry: { reason: "confirmed spelling" } },
            });
            expect(printed).toHaveLength(2);
            const applied = z
                .object({ entry: z.object({ token: z.string() }) })
                .parse(SafeJSON.parse(String(printed[1])));
            const undo = new Command().exitOverride();
            await registerRequestedTrees({ program: undo, registrars: MEETINGS_REGISTRARS, requested: "reopen" });
            await undo.parseAsync(["reopen", meeting.id, "--token", applied.entry.token, "--json"], { from: "user" });
            expect(new MeetingStore().read(meeting.id)?.items[0]).toMatchObject({
                status: "suggested",
                proposed: "Aster",
            });
        } finally {
            output.mockRestore();
            process.exitCode = 0;
        }
    });

    test("--except stays open and --replaces changes an answered question atomically", async () => {
        const store = new MeetingStore();
        const at = "2026-11-02T14:00:00.000Z";
        const meeting = await store.create(
            {
                title: "Planning",
                start: at,
                createdBy: "new",
                items: ["i1", "i2"].map((id) => ({
                    id,
                    kind: "question",
                    status: "suggested",
                    about: "term",
                    heard: "Ada",
                    fromSec: 10,
                    toSec: 20,
                    question: "Which word?",
                    choices: ["Atlas", "Aster"],
                    decides: [],
                    rules: [],
                    suggestedAt: at,
                })),
            },
            { command: "test", change: "fixture" }
        );
        const printed: string[] = [];
        const result = spyOn(out, "result").mockImplementation((value) => {
            printed.push(String(value));
        });
        const run = async (...flags: string[]) => {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
            await program.parseAsync(["listen", meeting.id, "--item", "i1", ...flags, "--json"], { from: "user" });
        };
        try {
            await run("--answer", "Atlas", "--except", "i2");
            const first = journalEntrySchema.parse(SafeJSON.parse(printed[0]!, { strict: true }));
            expect(first.token).toBeString();
            expect(new MeetingStore().read(meeting.id)?.items.map((item) => item.status)).toEqual([
                "confirmed",
                "suggested",
            ]);
            await run("--answer", "Aster", "--except", "i2", "--replaces", first.token);
            const saved = new MeetingStore().read(meeting.id)!;
            expect(saved.items[0]).toMatchObject({ answer: "Aster", status: "confirmed" });
            expect(saved.items[1]?.status).toBe("suggested");
            expect(SafeJSON.parse(printed[1]!, { strict: true })).toMatchObject({
                action: { kind: "answer", except: ["i2"], replaces: first.token },
            });
        } finally {
            result.mockRestore();
            process.exitCode = 0;
        }
    });
});

test("terminal listen stops its in-process playback before search and comment prompts, then restarts", async () => {
    const cli = await import("@genesiscz/utils/cli");
    // lint-rules-ignore: the test spies on the @clack/prompts module itself, which the prompts facade re-exports
    const clack = await import("@clack/prompts");
    const choices = await import("@genesiscz/utils/prompts/clack/choice-select");
    const search = await import("@genesiscz/utils/prompts/clack/search-select");
    const audio = await import("./audio");
    const clients = await import("./service/client");
    const directory = await import("@genesiscz/utils/meetings/people-directory");
    const { MeetingsConfigStore } = await import("@genesiscz/utils/meetings/config");
    const { OpenedMeeting } = await import("./opened-meeting");
    const at = "2026-11-02T14:00:00.000Z";
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Silent terminal contract",
            start: at,
            createdBy: "new",
            participants: [{ name: "Alice Example", self: true, from: ["manual"] }],
            items: [
                {
                    id: "i1",
                    kind: "question",
                    status: "suggested",
                    question: "Who speaks?",
                    about: "speaker",
                    fromSec: 10,
                    toSec: 10,
                    choices: ["Alice Example", "Bob Example"],
                    confidence: 0.4,
                    priority: 1,
                    decides: [],
                    rules: [],
                    suggestedAt: at,
                },
            ],
        },
        { command: "test", change: "fixture" }
    );
    const settings = meetingsConfigSchema.parse({
        global: {
            playback: {
                listen: {
                    padBeforeSec: 5,
                    padAfterSec: 5,
                    delaySec: 0,
                    minPriority: 0,
                    roundCap: 1,
                    repeat: { enabled: true, gapSec: 1 },
                },
            },
        },
    });
    const events: string[] = [];
    let active = false;
    let prompts = 0;
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        throw new Error("Playback test forbids subprocesses");
    });
    const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
        throw new Error("Playback test forbids subprocesses");
    });
    const interactive = spyOn(cli, "isInteractive").mockReturnValue(true);
    const config = spyOn(MeetingsConfigStore.prototype, "read").mockResolvedValue(settings);
    const people = spyOn(directory, "meetingPeopleNames").mockResolvedValue(["Alice Example", "Bob Example"]);
    const source = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue({
        sourceMeetingId: "fixture",
        title: record.title,
        start: at,
        participants: [],
        speakers: [],
        folders: [],
        transcript: [{ startSec: 10, speaker: "Voice", text: "A sentence." }],
    });
    const path = spyOn(OpenedMeeting.prototype, "audioPath").mockResolvedValue("/fixture-unused.wav");
    const client = spyOn(clients, "openMeetingsClient").mockImplementation(
        async () => new InProcessMeetingsClient({ deps: { store: () => store } })
    );
    const player = spyOn(audio, "clipPlayer").mockReturnValue("afplay");
    const cut = spyOn(audio, "cutClip").mockResolvedValue(undefined);
    const playback = spyOn(audio, "playClip").mockImplementation((_player, _file, options) => {
        expect(options?.repeatGapMs).toBe(1000);
        active = true;
        events.push("start");
        return {
            positionSec: 0,
            pause() {
                active = false;
                events.push("pause");
            },
            resume() {
                active = true;
                events.push("resume");
            },
            stop() {
                active = false;
                events.push("stop");
            },
        };
    });
    const select = spyOn(choices, "choiceSelect").mockImplementation(async <T>(options: ChoiceSelectOptions<T>) => {
        prompts++;
        expect(active).toBe(true);
        expect(options.footer).toContain("space pause/resume");
        if (prompts === 1) {
            options.onSpace!();
            expect(active).toBe(false);
            options.onSpace!();
            expect(active).toBe(true);
        }
        const action = prompts === 1 ? "\u0000other" : prompts === 2 ? "\u0000comment" : "\u0000stop";
        const row = options.rows.find((row) => String(row.value) === action);
        if (!row) {
            throw new Error("Expected terminal action missing");
        }
        return row.value;
    });
    const searching = spyOn(search, "searchSelect").mockImplementation(async () => {
        expect(active).toBe(false);
        events.push("search");
        return search.searchSelectCancelSymbol;
    });
    const text = spyOn(clack, "text").mockImplementation(async () => {
        expect(active).toBe(false);
        events.push("comment");
        return "";
    });
    try {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "listen" });
        await program.parseAsync(["listen", record.id, "--item", "Q1"], { from: "user" });
        expect(process.exitCode ?? 0).toBe(0);
        expect(prompts).toBe(3);
        expect(events).toEqual([
            "start",
            "pause",
            "resume",
            "stop",
            "search",
            "start",
            "stop",
            "comment",
            "start",
            "stop",
        ]);
        expect(active).toBe(false);
        expect(cut).toHaveBeenCalledTimes(1);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
        expect(new MeetingStore(store.storage).read(record.id)!.items[0]!.status).toBe("suggested");
    } finally {
        for (const mock of [
            text,
            searching,
            select,
            playback,
            cut,
            player,
            client,
            path,
            source,
            people,
            config,
            interactive,
            spawnSync,
            spawn,
        ]) {
            mock.mockRestore();
        }
        process.exitCode = 0;
    }
});

const p6VoiceSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
    for (const mock of p6VoiceSpies.splice(0).reverse()) {
        mock.mockRestore();
    }
});
const p6Alice = { person: "Alice Example" },
    p6Bob = { person: "Bob Example" };
const p6Print: VoicePrint = {
    meeting: "training",
    sourceSha: "digest",
    seat: "mic",
    track: "source-mic",
    fromSec: 0,
    toSec: 5,
    embedding: [1, 0],
    confirmedAt: "2026-11-01T10:00:00Z",
};
test("voice readiness in show JSON counts attended people and requires one sampled person on each occupied seat", async () => {
    const store = new MeetingStore();
    const project = "readiness-fixture";
    const record = await store.create(
        {
            title: "Voice readiness",
            start: "2026-11-01T10:00:00Z",
            createdBy: "new",
            project,
            participants: [p6Alice.person, p6Bob.person].map((name) => ({ name, from: ["fixture"], firstSeenSec: 0 })),
        },
        { command: "new", change: "fixture" }
    );
    const output = spyOn(out, "result").mockImplementation(() => {});
    const show = async () => {
        const program = new Command().exitOverride();
        await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "show" });
        await program.parseAsync(["show", record.id, "--json"], { from: "user" });
        return SafeJSON.parse(String(output.mock.calls.at(-1)?.[0]));
    };
    const backfill = `tools meetings voices backfill --project ${project}`;
    try {
        expect(await show()).toMatchObject({
            voice: {
                seats: false,
                samples: 0,
                ready: false,
                hints: [`tools meetings seats ${record.id} --apply`, backfill],
            },
        });
        await store.update(record.id, { command: "set", change: "seats" }, (current) => {
            current.seats = { room: [p6Alice.person, "Carol Example"], remote: [{ name: p6Bob.person }] };
        });
        addVoicePrint(project, p6Alice.person, p6Print, "fixture-model");
        addVoicePrint(project, "Visitor Example", p6Print, "fixture-model");
        addVoicePrint(project, p6Bob.person, p6Print, "fixture-model");
        expect(await show()).toMatchObject({ voice: { seats: true, samples: 2, ready: false, hints: [backfill] } });
        addVoicePrint(project, p6Bob.person, { ...p6Print, track: "source-call", seat: "call" }, "fixture-model");
        expect(await show()).toMatchObject({
            voice: {
                samples: 3,
                people: { "Alice Example": 1, "Bob Example": 2, "Carol Example": 0 },
                ready: true,
                hints: [`tools meetings voices preview ${record.id}`],
            },
        });
        await store.update(
            record.id,
            { command: "suggest", change: "suggest findings and questions with voice naming" },
            () => {}
        );
        expect(await show()).toMatchObject({ voice: { ready: true, hints: [] } });
    } finally {
        output.mockRestore();
    }
});

test("listen slices reject any muted overlap, fall back to source, and keep half-open boundaries", () => {
    const sound = meetingSound({
        folder: "/fixture",
        timelineZeroMs: 0,
        tracks: "best",
        rows: [
            {
                file: "mic.m4a",
                source: "mic",
                at: "1970-01-01T00:00:10Z",
                durationMs: 30000,
                mutedSpans: [[2000, 4000]],
            },
        ],
        source: { path: "/source", source: "wisprflow", layout: "left-mic", durationSec: 100 },
    });
    const request = { seat: "mic" as const, purpose: "listen" as const, fromSec: 11, toSec: 12 };
    expect(sound.slice(request)?.track).toBe("mic-raw");
    expect(sound.slice({ ...request, toSec: 12.1 })?.track).toBe("source-mic");
    expect(sound.slice({ ...request, fromSec: 14, toSec: 15 })?.track).toBe("mic-raw");
    expect(sound.slice({ ...request, fromSec: 12, toSec: 14, track: "mic-raw" })).toBeUndefined();
    expect(sound.slice({ ...request, fromSec: 11, toSec: 15, track: "mic-raw" })).toBeUndefined();
});

test("voice preview measures in memory, returns refusals and current names, and writes neither clock nor record", async () => {
    const store = new MeetingStore(new Storage("voice-preview-fixture"));
    const record = await store.create(
        { title: "Preview", start: "2026-11-01T10:00:00Z", createdBy: "new", project: "preview-voice-fixture" },
        { command: "new", change: "fixture" }
    );
    const opened = OpenedMeeting.of(store, record);
    const inputs: soundModule.SoundInputs = {
        folder: store.folder(record.id),
        timelineZeroMs: 0,
        tracks: "best",
        rows: [{ file: "mic.m4a", source: "mic", at: "1970-01-01T00:00:00Z", durationMs: 30000, mutedSpans: [] }],
    };
    const before = readFileSync(store.path(record.id));
    const saved = spyOn(soundModule, "saveSoundClock").mockImplementation(() => {
        throw new Error("preview must not save a clock");
    });
    const update = spyOn(store, "update").mockRejectedValue(new Error("preview must not save a record"));
    const propose = spyOn(labelsModule, "proposeSpeakerLabels").mockImplementation(async (safe, options) => {
        expect(options.seat.enabled).toBe(false);
        expect((await safe.sound()).tracks[0]?.clock).toBe("measured");
        return [
            {
                labeler: "voice",
                index: 0,
                seat: "mic",
                score: 0.4,
                reason: "unsampled-present",
                next: { person: p6Bob.person, score: 0 },
            },
        ];
    });
    p6VoiceSpies.push(
        saved,
        update,
        propose,
        spyOn(OpenedMeeting, "of").mockReturnValue(opened),
        spyOn(opened, "meeting").mockResolvedValue({
            sourceMeetingId: "fixture",
            title: "Preview",
            start: record.start,
            participants: [],
            speakers: [],
            folders: [],
            transcript: [{ speaker: "Speaker 1", startSec: 0, text: "Some words." }],
        }),
        spyOn(opened, "config").mockResolvedValue(meetingsConfigSchema.parse({})),
        spyOn(soundModule, "readSoundInputs").mockResolvedValue(inputs),
        spyOn(soundModule, "measureSoundClock").mockResolvedValue({
            clock: { version: 1, sources: { mic: { correctionSec: 0, pieces: 1, clear: 1 } } },
            pieces: [],
        })
    );
    const result = await previewVoices({ store, meeting: record.id });
    expect(result.lines).toMatchObject([
        {
            current: "Speaker 1",
            text: "Some words.",
            score: 0.4,
            reason: "unsampled-present",
            next: { person: p6Bob.person },
        },
    ]);
    expect(saved).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(store.path(record.id))).toEqual(before);
});

test("voice reads suppress a failed clock measurement without letting the base labeler save it", async () => {
    const store = new MeetingStore(new Storage("voice-stamp-read-fixture"));
    const record = await store.create(
        { title: "Stamp", start: "2026-11-01T10:00:00Z", createdBy: "new" },
        { command: "new", change: "fixture" }
    );
    p6VoiceSpies.push(
        spyOn(soundModule, "readSoundInputs").mockResolvedValue({
            folder: store.folder(record.id),
            timelineZeroMs: 0,
            tracks: "best",
            rows: [{ file: "mic", source: "mic", at: "1970-01-01T00:00:00Z", durationMs: 30000, mutedSpans: [] }],
        }),
        spyOn(soundModule, "measureSoundClock").mockResolvedValue(undefined)
    );
    const opened = await voiceReadMeeting(OpenedMeeting.of(store, record));
    expect((await opened.sound()).tracks).toEqual([]);
    expect((await opened.sound()).slice({ seat: "mic", fromSec: 1, toSec: 3, purpose: "voice" })).toBeUndefined();
});

test("sample reads use the confirmed track and hash; removal invalidates project suggestions but preserves decisions", async () => {
    const store = new MeetingStore(new Storage("voice-removal-fixture"));
    const project = "remove-voice-fixture";
    const create = (title: string) =>
        store.create(
            { title, start: "2026-11-01T10:00:00Z", createdBy: "new", project },
            { command: "new", change: "fixture" }
        );
    const first = await create("One"),
        second = await create("Two");
    for (const record of [first, second]) {
        await store.update(record.id, { command: "new", change: "fixture suggestions" }, (record) => {
            record.items = [
                {
                    id: "i1",
                    kind: "speaker-range",
                    label: "Speaker 1",
                    speaker: p6Alice.person,
                    fromSec: 1,
                    toSec: 4,
                    status: "suggested",
                    rules: [MeetingRule.VoiceEmbedding],
                    suggestedAt: p6Print.confirmedAt,
                },
                {
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 1",
                    speaker: p6Alice.person,
                    fromSec: 5,
                    toSec: 8,
                    status: "confirmed",
                    rules: [MeetingRule.VoiceEmbedding],
                    suggestedAt: p6Print.confirmedAt,
                },
            ];
        });
    }
    const audio = `${store.folder(first.id)}/source.wav`;
    writeFileSync(audio, "native rate audio");
    addVoicePrint(
        project,
        p6Alice.person,
        {
            ...p6Print,
            meeting: first.id,
            fromSec: 1,
            toSec: 4,
            sourceSha: createHash("sha256").update(readFileSync(audio)).digest("hex"),
        },
        "fixture-model"
    );
    const sound = meetingSound({
        folder: store.folder(first.id),
        timelineZeroMs: 0,
        rows: [],
        tracks: "best",
        source: { path: audio, source: "wisprflow", layout: "left-mic", durationSec: 30 },
    });
    p6VoiceSpies.push(
        spyOn(OpenedMeeting.prototype, "sound").mockResolvedValue(sound),
        spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue({
            sourceMeetingId: "fixture",
            title: "One",
            start: first.start,
            participants: [],
            speakers: [],
            folders: [],
            transcript: [{ speaker: p6Alice.person, startSec: 1, text: "The sample words." }],
        })
    );
    const before = readFileSync(store.path(first.id));
    const model = spyOn(voiceBackend, "localVoiceBackend").mockImplementation(() => {
        throw new Error("a voice list must not load a model");
    });
    const embed = spyOn(voiceBackend, "embedVoiceLines").mockRejectedValue(
        new Error("a voice list must not embed a meeting")
    );
    p6VoiceSpies.push(model, embed);
    const listed = await listProjectVoices({ store, project });
    expect(listed.people.find((row) => row.person === p6Alice.person)?.samples[0]).toMatchObject({
        sample: 1,
        words: "The sample words.",
        seat: "mic",
        track: "source-mic",
    });
    expect(await voiceSample({ store, project, person: p6Alice.person })).toMatchObject({
        path: audio,
        fileFromSec: 1,
        fileToSec: 4,
        channel: 0,
        track: "source-mic",
    });
    expect(readFileSync(store.path(first.id))).toEqual(before);
    expect(model).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(planVoiceRemoval({ store, project, person: p6Alice.person }).affected).toHaveLength(2);
    await removeVoice({ store, project, person: p6Alice.person });
    expect(readVoiceStore(project).people[p6Alice.person]).toBeUndefined();
    for (const record of [first, second]) {
        expect(new MeetingStore(store.storage).read(record.id)?.items.map((item) => item.id)).toEqual(["i2"]);
    }
});

test("voices apply delegates to the existing speakers pass and never confirms its output", async () => {
    const store = new MeetingStore(new Storage("voice-apply-fixture"));
    const record = await store.create(
        { title: "Apply", start: "2026-11-01T10:00:00Z", createdBy: "new", project: "apply-voice-fixture" },
        { command: "new", change: "fixture" }
    );
    const run = spyOn(suggestRun, "runSuggest").mockResolvedValue({
        fresh: [],
        retired: [],
        warnings: ["fixture warning"],
    });
    p6VoiceSpies.push(run);
    expect(await applyVoices({ store, meeting: record.id })).toEqual({
        meeting: record.id,
        added: 0,
        warnings: ["fixture warning"],
    });
    expect(run).toHaveBeenCalledWith({ store, record, rules: ["speakers"] });
});

test("removing one numbered sample preserves other tracks sharing its meeting and start time", async () => {
    const store = new MeetingStore(new Storage("voice-numbered-removal-fixture"));
    const project = "numbered-removal-fixture";
    addVoicePrint(project, p6Alice.person, p6Print, "fixture-model");
    addVoicePrint(project, p6Alice.person, { ...p6Print, track: "mic-raw" }, "fixture-model");
    addVoicePrint(project, p6Alice.person, { ...p6Print, toSec: 6 }, "fixture-model");
    await removeVoice({ store, project, person: p6Alice.person, sample: 1 });
    expect(
        readVoiceStore(project).people[p6Alice.person]?.samples.map((sample) => [sample.track, sample.toSec])
    ).toEqual([
        ["mic-raw", 5],
        ["source-mic", 6],
    ]);
});
