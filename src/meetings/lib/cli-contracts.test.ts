import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
import { createCanvas } from "@napi-rs/canvas";
import { Command } from "commander";
import { z } from "zod";
import { MEETINGS_REGISTRARS } from "../registrars";
import { meetingAudioPath } from "./audio";
import { MeetingComments } from "./comments";
import { journalEntrySchema } from "./decision-actions";
import { meetingListRow, selectMeetings } from "./list-rows";
import { planMoment } from "./moment";
import { choosePlayer, PLAYERS, pastTheEnd, playbackPlan } from "./players";
import { InProcessMeetingsClient } from "./service/client";
import { MeetingsServiceError } from "./service/handlers";
import * as momentHandlers from "./service/moment-handlers";
import { enumHint, errorJSON, errorText, fail, formatFlag } from "./shared";
import { linkedSource } from "./sources";

/**
 * What the `tools meetings` commands promise a script or the Meetings window: a refusal names a command that runs,
 * an error code leads its sentence, a JSON shape stays. Each test pins one promise.
 */
test("service comment refusals keep their code in human and JSON errors", () => {
    const error = new MeetingsServiceError("already-read", "The receiver acknowledged it.");
    expect(errorText(error)).toBe("[already-read] The receiver acknowledged it.");
    expect(SafeJSON.parse(errorJSON(error), { strict: true })).toMatchObject({
        error: { data: { code: "already-read" } },
    });
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
            { value: "OMP", label: "Keep as heard", role: "heard", action: { kind: "reject" } },
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
        const run = async (...args: string[]) => {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "comments" });
            await program.parseAsync(["comments", ...args, "--json"], { from: "user" });
        };
        try {
            await run("stage", meeting.id, "--target", '{"kind":"time","atSec":3}', "--text", "Check this word");
            await run("send", meeting.id);
            await run("read", meeting.id, "c1");
            expect(printed).toHaveLength(3);
            expect(MeetingComments.of(new MeetingStore(), meeting.id).list()[0]).toMatchObject({
                id: "c1",
                state: "sent",
                text: "Check this word",
                readAt: expect.any(String),
            });
        } finally {
            output.mockRestore();
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
