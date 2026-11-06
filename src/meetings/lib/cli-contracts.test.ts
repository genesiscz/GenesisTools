import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
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
