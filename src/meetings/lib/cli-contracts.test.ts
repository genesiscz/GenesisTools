import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "../registrars";
import { meetingAudioPath } from "./audio";
import { meetingListRow, selectMeetings } from "./list-rows";
import { choosePlayer, PLAYERS, pastTheEnd, playbackPlan } from "./players";
import { enumHint, errorText, formatFlag } from "./shared";
import { linkedSource } from "./sources";

/**
 * What the `tools meetings` commands promise a script or the Meetings window: a refusal names a command that runs,
 * an error code leads its sentence, a JSON shape stays. Each test pins one promise.
 */
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
            'await import("@genesiscz/utils/image/render-plan");',
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

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "evidence" });
            await program.parseAsync(["evidence", created.id], { from: "user" });
        } finally {
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

    test("--project filters before --limit, so the limit counts that project's meetings", () => {
        const records = [
            meeting("c", "2026-11-05T12:00:00.000Z"),
            meeting("b", "2026-11-05T11:00:00.000Z", "work"),
            meeting("a", "2026-11-05T10:00:00.000Z", "work"),
        ];

        expect(selectMeetings(records, { limit: 2 }).map((one) => one.id)).toEqual(["c", "b"]);
        expect(selectMeetings(records, { project: "work", limit: 1 }).map((one) => one.id)).toEqual(["b"]);
        expect(selectMeetings(records, {}).map((one) => one.id)).toEqual(["c", "b", "a"]);
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

    test("choices are typed with confidence: the earlier answer first, then scored ones, then the rest, then the actions", async () => {
        const { reviewRow } = await import("./review-rows");
        const term = reviewRow(record, record.items[2]!);
        const speaker = reviewRow(record, record.items[3]!);

        expect(term.choices.map((choice) => [choice.role, choice.value, choice.confidence])).toEqual([
            ["earlier", "EMP", 0.7],
            ["presumed", "AMP", 0.82],
            ["heard", "OMP", 0.4],
            ["none", "none of these", undefined],
            ["skip", "skip", undefined],
        ]);
        expect(term.choices[0]).toMatchObject({ hint: "as at 00:30", action: { kind: "answer", answer: "EMP" } });
        expect(speaker.choices.map((choice) => [choice.role, choice.value, choice.confidence])).toEqual([
            ["suggested", "Alice Example", 0.6],
            ["candidate", "Bob Example", undefined],
            ["none", "none of these", undefined],
            ["split", "split", undefined],
            ["skip", "skip", undefined],
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
