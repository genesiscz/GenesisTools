/**
 * Builds a sandbox home with invented meetings, so the Meetings window of GenesisTools.app can be shown and
 * screenshotted without any real data.
 *
 *   bun scripts/fixtures/meetings-sandbox.ts --home <dir>
 *
 * Writes `<dir>/.genesis-tools/` through the real writers (`MeetingStore`, `MeetingsConfigStore`) and, because the
 * transcript of a meeting only ever comes from the Wispr Flow source, a small Wispr Flow data folder under
 * `<dir>/Library/Application Support/Wispr Flow/` (the SQLite file and one `refined.ndjson` per meeting, only the
 * columns the readers use). `src/wisprflow/lib/local.ts` finds that folder through `homedir()`, so the window must run
 * with `HOME=<dir>` as well as `GENESIS_TOOLS_HOME=<dir>`; the command this script prints sets both.
 *
 * Every name, company and product here is invented. Nothing is read from the real `~/.genesis-tools`. A second run on
 * the same folder rebuilds it (the folder carries a marker file; a folder without one is refused).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import {
    type MeetingContext,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    type RecordingBlock,
} from "@genesiscz/utils/meetings/record";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import type { DictionaryEntry } from "@genesiscz/utils/transcribe/dictionary";
import { createCanvas } from "@napi-rs/canvas";
import { windowOpenArgs } from "../../src/meetings/lib/window";

const MARKER = ".meetings-sandbox";
const REPO_ROOT = resolve(dirname(import.meta.path), "..", "..");

const NORTHWIND = "Northwind-app";
const HARBOR = "Harbor-site";
const NORTHWIND_FOLDER = "Northwind app";
const HARBOR_FOLDER = "Harbor site";

const ALICE = "Alice Novak";
const BEN = "Ben Carter";
const CHLOE = "Chloe Diaz";
const PEOPLE = [ALICE, BEN, CHLOE];

type Line = [speaker: 0 | 1 | 2, sec: number, text: string];

interface MeetingSeed {
    key: string;
    title: string;
    daysAgo: number;
    hour: number;
    minute: number;
    durationMin: number;
    /** For a meeting of today: how many minutes before the run it starts when its clock time is still ahead. */
    agoMin?: number;
    project?: string;
    labels?: string[];
    folder?: string;
    /** The transcript, as the invented Wispr Flow meeting keeps it. Absent: no transcript source. */
    transcript?: Line[];
    summary?: string;
}

const SEEDS: MeetingSeed[] = [
    {
        key: "sprint",
        title: "Northwind app sprint planning",
        daysAgo: 2,
        hour: 10,
        minute: 0,
        durationMin: 50,
        project: NORTHWIND,
        labels: ["Checkout 2.0"],
        folder: NORTHWIND_FOLDER,
        summary:
            "## Summary\n- <@speaker:0> opened with the sprint goal: a one-page checkout for the Northwind app.\n" +
            "- <@speaker:1> estimated the payment sheet at five days.\n\n## Next steps\n" +
            "- <@speaker:2> drafts the empty-basket screen by Thursday.\n- <@speaker:1> splits the payment sheet into two tickets.",
        transcript: [
            [0, 4, "Good morning. The goal for this sprint is a one-page checkout in the Northwind app."],
            [1, 21, "Before we commit, I want to know who owns the payment sheet. It touches three screens."],
            [0, 38, "I would give it to you, Ben. Chloe, can you take the empty-basket state and the order summary?"],
            [2, 55, "Yes. I have the mockups from last week, so the summary is mostly spacing and copy."],
            [1, 80, "The payment sheet is five days if the card form does not change again. I would split it in two."],
            [0, 104, "Split it. One ticket for the card form, one for the saved-card list."],
            [2, 127, "Do we show the delivery estimate on the checkout page or only after the order?"],
            [0, 143, "On the page. Customers asked for it twice in the last survey."],
            [1, 168, "Then the delivery estimate is a third ticket. It needs the new shipping endpoint."],
            [2, 190, "I can pair with you on that, Ben. My Thursday is free after the design review."],
            [
                0,
                214,
                "Good. Let me read the list back. Payment card form, saved cards, delivery estimate, empty basket.",
            ],
            [1, 240, "Order summary too. That makes five tickets and about nine days of work for three people."],
            [0, 262, "Nine days fits the sprint with a day of slack. We take it."],
            [2, 281, "I will post the final ticket list in the channel before lunch."],
        ],
    },
    {
        key: "copy",
        title: "Harbor site content review",
        daysAgo: 1,
        hour: 14,
        minute: 0,
        durationMin: 35,
        project: HARBOR,
        labels: ["Launch copy"],
        folder: HARBOR_FOLDER,
        summary:
            "## Summary\n- <@speaker:2> walked through the homepage copy. The hero headline stays.\n" +
            "- The tour page needs shorter paragraphs.\n\n## Next steps\n" +
            "- <@speaker:2> rewrites the tour page intro.\n- <@speaker:1> checks the photo alt texts.\n" +
            "- <@speaker:0> books the proofreading slot.",
        transcript: [
            [2, 6, "I went through the homepage copy last night. The hero headline works, I would keep it."],
            [0, 26, "Agreed. What about the tour page? It felt long when I read it on my phone."],
            [2, 45, "Too long. Each paragraph should be three sentences at most."],
            [1, 70, "I can check the photo captions. Some of them say photo one, photo two, which helps nobody."],
            [0, 95, "Please do. Chloe, the old harbor walk needs a new description too."],
            [2, 118, "Yes. I will track those copy tasks on the lantern bored so nobody edits the same page twice."],
            [1, 150, "On the quay side we should mention the ferry timetable. People ask about it every week."],
            [0, 178, "Put the timetable in the footer and link it from the tour page."],
            [2, 205, "Fine. I think we also need a short line about the winter opening hours."],
            [1, 612, "I looked at the contact page again. The form works, but the thank-you text is missing."],
            [1, 640, "It is only one sentence, so I will write it myself and send it to you for review."],
            [2, 662, "Send it today and I will fold it into the proofreading pass."],
            [0, 700, "Great. Then the launch copy is done once the tour page and the thank-you text are in."],
            [1, 838, "One more thing. The newsletter box says subscribe"],
            [1, 841, "and then nothing happens on mobile. I will open a ticket."],
            [0, 870, "Thanks, Ben. That is everything for today."],
        ],
    },
    {
        key: "triage",
        title: "Lanternboard bug triage",
        daysAgo: 1,
        hour: 16,
        minute: 0,
        durationMin: 25,
        project: NORTHWIND,
        folder: NORTHWIND_FOLDER,
        transcript: [
            [1, 5, "Three bugs on the list. The first one is cards jumping to the wrong column after a drag."],
            [0, 28, "I can reproduce that on the tablet. It only happens when the board is scrolled."],
            [2, 52, "The second bug is the notification badge. It stays after you open the board."],
            [1, 80, "That one is old. I think the read marker is saved for the wrong user."],
            [0, 110, "Let us fix the drag bug first, it blocks the demo on Friday."],
            [2, 140, "I can take the badge. I have already looked at the read marker code."],
            [1, 175, "Third bug. When a card has no title the board shows an empty rectangle."],
            [2, 418, "Honestly the lantern bored feels slow since the last release, maybe the sync is the cause."],
            [0, 445, "Let us measure it before we guess. Ben, can you capture a trace on the tablet?"],
            [1, 470, "Yes. I will attach the trace to the ticket tomorrow morning."],
            [0, 495, "Good. We stop here."],
        ],
    },
    {
        key: "walkthrough",
        title: "Harbor site walkthrough",
        daysAgo: 0,
        hour: 11,
        minute: 0,
        durationMin: 40,
        agoMin: 200,
        project: HARBOR,
        labels: ["Photo shoot"],
        folder: HARBOR_FOLDER,
        transcript: [
            [2, 8, "I am sharing my screen. This is the homepage draft with the new hero headline."],
            [0, 30, "Looks good. Can you open the tour calendar next?"],
            [2, 52, "Sure. Saturday has two tours now, the old harbor walk and the evening cruise."],
            [1, 90, "The evening cruise needs a booking limit. The boat takes twelve people."],
            [2, 118, "I will add the limit to the form. Now the gallery. I uploaded twelve photos this morning."],
            [0, 150, "Three of them have no alt text. Please fix that before we launch."],
            [2, 176, "Done after the call. Last, the launch checklist. Most of it is ticked."],
            [1, 220, "The only open box is the redirect from the old address."],
            [0, 241, "I will ask the host for that today."],
        ],
    },
    {
        key: "checkin",
        title: "Northwind checkout copy for Harbor launch",
        daysAgo: 0,
        hour: 9,
        minute: 15,
        durationMin: 20,
        agoMin: 90,
        transcript: [
            [
                0,
                4,
                "Quick check-in. The checkout copy for Northwind and the launch banner for Harbor use the same words.",
            ],
            [1, 24, "Right. The banner says free delivery, but the checkout page says delivery from five dollars."],
            [0, 46, "That is wrong on one of them. Chloe, which one is current?"],
            [2, 63, "The checkout page. The banner is from the old campaign."],
            [0, 84, "Then we change the banner. Ben, can you do it today?"],
            [1, 101, "Yes, it is one line."],
        ],
    },
    {
        key: "debrief",
        title: "Harbor site photo shoot debrief",
        daysAgo: 2,
        hour: 16,
        minute: 30,
        durationMin: 30,
        project: HARBOR,
    },
];

interface FrameDraw {
    background: string;
    /** The lines drawn on the frame, top to bottom. */
    lines: string[];
    /** Seconds into the meeting. */
    sec: number;
}

const FRAME_W = 1280;
const FRAME_H = 800;

const FRAMES: FrameDraw[] = [
    {
        sec: 120,
        background: "#1f3a4d",
        lines: ["Harbor site - Homepage draft", "Sail into spring", "Book a harbor tour", "Tours   Gallery   Contact"],
    },
    {
        sec: 360,
        background: "#27465c",
        lines: [
            "Harbor site - Tour calendar",
            "Saturday 10:00 Old harbor walk",
            "Saturday 18:30 Evening cruise",
            "Booking limit: 12 people",
        ],
    },
    {
        sec: 780,
        background: "#34543f",
        lines: ["Harbor site - Gallery", "12 photos uploaded", "Alt text missing on 3 photos", "Upload more photos"],
    },
    {
        sec: 1260,
        background: "#5a4630",
        lines: [
            "Harbor site - Launch checklist",
            "Done: hero headline",
            "Done: tour calendar",
            "Open: redirect from the old address",
        ],
    },
];

const DICTIONARY: DictionaryEntry[] = [
    { type: "fix", value: "lantern bored", substitution: "Lanternboard" },
    { type: "fix", value: "NW app", substitution: "Northwind app", caseSensitive: true },
    { type: "abbr", value: "PDP", substitution: "PDP (product detail page)" },
    { type: "term", value: "Lanternboard", spoken: ["lantern board"], meaning: "the shared planning board" },
];

function quote(text: string): string {
    if (/^[\w@%+=:,./-]+$/.test(text)) {
        return text;
    }

    return `'${text.replaceAll("'", "'\\''")}'`;
}

function sqliteTime(date: Date): string {
    return `${date.toISOString().replace("T", " ").replace("Z", "")} +00:00`;
}

function clock(sec: number): string {
    const minutes = Math.floor(sec / 60);
    return `${minutes}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * The start of a seed: its local clock time `daysAgo` days back. A meeting of today whose clock time is still ahead
 * starts `agoMin` minutes before the run instead, so the sandbox always has meetings today.
 */
function startOf(seed: MeetingSeed, now: Date): Date {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - seed.daysAgo, seed.hour, seed.minute);
    const ahead = start.getTime() + seed.durationMin * 60_000 > now.getTime() - 120_000;

    if (!ahead) {
        return start;
    }

    return seed.agoMin === undefined
        ? new Date(start.getTime() - 24 * 60 * 60_000)
        : new Date(now.getTime() - seed.agoMin * 60_000);
}

function assertSafeHome(home: string): void {
    if (home === "/" || home === resolve(homedir())) {
        throw new Error(`--home ${home} is the real home or the root. Give a scratch folder.`);
    }

    if (existsSync(home) && readdirSync(home).length > 0 && !existsSync(join(home, MARKER))) {
        throw new Error(`${home} is not empty and was not made by this script (no ${MARKER}). Give a new folder.`);
    }
}

function resetHome(home: string): void {
    assertSafeHome(home);

    for (const path of [genesisToolsDirIn(home), join(home, "Library"), join(home, "notes")]) {
        rmSync(path, { recursive: true, force: true });
    }

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, MARKER), "Made by scripts/fixtures/meetings-sandbox.ts. Safe to rebuild.\n");
}

function wisprDir(home: string): string {
    return join(home, "Library", "Application Support", "Wispr Flow");
}

/** The slice of Wispr Flow's database the readers in `src/wisprflow/lib/local.ts` query. */
function createWisprDatabase(home: string): Database {
    const dir = wisprDir(home);
    mkdirSync(join(dir, "meetings"), { recursive: true });
    const db = new Database(join(dir, "flow.sqlite"), { create: true });
    db.run(`CREATE TABLE Meetings (
        id TEXT PRIMARY KEY, title TEXT, createdAt TEXT, modifiedAt TEXT, endedAt INTEGER, summary TEXT, notes TEXT,
        speakerMap TEXT, speakerMapPendingPush INTEGER DEFAULT 0, shareSlug TEXT, isDeleted INTEGER DEFAULT 0)`);
    db.run("CREATE TABLE Folders (id TEXT PRIMARY KEY, name TEXT)");
    db.run("CREATE TABLE FolderMeetings (folderId TEXT, meetingId TEXT)");
    db.run("CREATE TABLE TranscriptCorrections (entryId TEXT, meetingId TEXT, editedText TEXT, updatedAt TEXT)");
    db.run(`CREATE TABLE Dictionary (
        phrase TEXT, replacement TEXT, frequencyUsed INTEGER, manualEntry INTEGER, isSnippet INTEGER, lastUsed TEXT,
        isDeleted INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE Notes (
        id TEXT PRIMARY KEY, title TEXT, modifiedAt TEXT, contentPreview TEXT, searchableContent TEXT,
        isDeleted INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE CalendarEvents (
        externalId TEXT, title TEXT, startAtUtc INTEGER, endAtUtc INTEGER, conferenceUrl TEXT, participantNames TEXT,
        participants TEXT, status TEXT)`);
    db.run("INSERT INTO Folders VALUES ('folder-northwind', ?), ('folder-harbor', ?)", [
        NORTHWIND_FOLDER,
        HARBOR_FOLDER,
    ]);

    return db;
}

function speakerMap(): string {
    return SafeJSON.stringify({
        people: {
            p0: { name: ALICE, origin: "self" },
            p1: { name: BEN, origin: "calendar" },
            p2: { name: CHLOE, origin: "calendar" },
        },
        assignments: { "0": { consensus: "p0" }, "1": { consensus: "p1" }, "2": { consensus: "p2" } },
    });
}

function wisprId(key: string): string {
    return `fixture-${key}`;
}

function addWisprMeeting(options: { db: Database; home: string; seed: MeetingSeed; start: Date; end: Date }): void {
    const { db, home, seed, start, end } = options;
    const id = wisprId(seed.key);
    db.run("INSERT INTO Meetings VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, 0)", [
        id,
        seed.title,
        sqliteTime(start),
        sqliteTime(end),
        end.getTime(),
        seed.summary ?? null,
        speakerMap(),
    ]);

    if (seed.folder) {
        db.run("INSERT INTO FolderMeetings VALUES (?, ?)", [
            seed.folder === NORTHWIND_FOLDER ? "folder-northwind" : "folder-harbor",
            id,
        ]);
    }

    const folder = join(wisprDir(home), "meetings", id);
    mkdirSync(folder, { recursive: true });
    const rows = (seed.transcript ?? []).map(([speaker, sec, text], index) =>
        SafeJSON.stringify({ id: `${seed.key}-${index + 1}`, timestamp: clock(sec), text, speaker: { id: speaker } })
    );
    writeFileSync(join(folder, "refined.ndjson"), `${rows.join("\n")}\n`);
}

function addFrames(options: { folder: string; start: Date }): { rows: string[]; bytes: number; names: string[] } {
    const framesDir = join(options.folder, "frames");
    mkdirSync(framesDir, { recursive: true });
    const rows: string[] = [];
    const names: string[] = [];
    let bytes = 0;

    for (const frame of FRAMES) {
        const canvas = createCanvas(FRAME_W, FRAME_H);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = frame.background;
        ctx.fillRect(0, 0, FRAME_W, FRAME_H);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(0, 0, FRAME_W, 64);
        ctx.fillStyle = "#f4efe6";
        ctx.textBaseline = "top";
        const blocks = frame.lines.map((line, index) => {
            const size = index === 0 ? 30 : 40;
            const x = 80;
            const y = index === 0 ? 16 : 150 + index * 120;
            ctx.font = `${size}px sans-serif`;
            ctx.fillText(line, x, y);
            const width = ctx.measureText(line).width;
            return {
                text: line,
                confidence: 0.98,
                bounds: {
                    x: x / FRAME_W,
                    y: 1 - (y + size * 1.2) / FRAME_H,
                    width: width / FRAME_W,
                    height: (size * 1.2) / FRAME_H,
                },
            };
        });
        const at = new Date(options.start.getTime() + frame.sec * 1000);
        const stamp = [at.getHours(), at.getMinutes(), at.getSeconds()]
            .map((n) => String(n).padStart(2, "0"))
            .join("-");
        const file = `frames/${stamp}-000-d1.png`;
        const png = canvas.toBuffer("image/png");
        writeFileSync(join(options.folder, file), png);
        bytes += png.length;
        names.push(file);
        rows.push(
            SafeJSON.stringify({
                file,
                at: at.toISOString(),
                displayId: 1,
                text: frame.lines.join("\n"),
                changePercent: 18,
                reason: "change",
                blocks,
            })
        );
    }

    return { rows, bytes, names };
}

function itemTime(start: Date, sec: number): string {
    return new Date(start.getTime() + sec * 1000).toISOString();
}

function itemsFor(key: string, start: Date, end: Date): MeetingItem[] {
    const at = itemTime(start, 1000);

    if (key === "copy") {
        return [
            {
                kind: "speaker-range",
                id: "i1",
                status: "suggested",
                confidence: 0.82,
                rules: ["R1", "R5", "R13"],
                label: BEN,
                fromSec: 600,
                toSec: 720,
                speaker: CHLOE,
                candidates: [CHLOE, ALICE],
                suggestedAt: at,
            },
            {
                kind: "term",
                id: "i2",
                status: "confirmed",
                confidence: 0.9,
                rules: [],
                atSec: 118,
                heard: "lantern bored",
                proposed: "Lanternboard",
                suggestedAt: at,
                decidedAt: itemTime(end, 600),
            },
            {
                kind: "term",
                id: "i3",
                status: "rejected",
                confidence: 0.45,
                rules: [],
                atSec: 150,
                heard: "quay side",
                proposed: "Quayside",
                suggestedAt: at,
                decidedAt: itemTime(end, 620),
            },
            {
                kind: "join",
                id: "i4",
                status: "suggested",
                confidence: 0.7,
                rules: [],
                atSec: 841,
                speaker: BEN,
                joined: "The newsletter box says subscribe and then nothing happens on mobile.",
                suggestedAt: at,
            },
        ];
    }

    if (key === "triage") {
        return [
            {
                kind: "term",
                id: "i1",
                status: "suggested",
                confidence: 0.55,
                rules: [],
                atSec: 418,
                heard: "lantern bored",
                proposed: "Lanternboard",
                suggestedAt: at,
            },
            {
                kind: "question",
                id: "i2",
                status: "suggested",
                rules: [],
                about: "term",
                fromSec: 414,
                toSec: 428,
                question: `What did ${CHLOE} say here?`,
                heard: "lantern bored",
                choices: ["Lanternboard", "lantern board"],
                decides: ["i1"],
                priority: 0.8,
                suggestedAt: at,
            },
        ];
    }

    return [];
}

function contextFor(key: string, at: string): MeetingContext[] {
    if (key === "sprint") {
        return [
            {
                id: "c1",
                kind: "note",
                ref: "Agenda: scope the checkout 2.0 sprint, confirm who owns the payment sheet.",
                title: "Agenda",
                addedAt: at,
                addedBy: "user",
            },
        ];
    }

    if (key === "copy") {
        return [
            {
                id: "c1",
                kind: "url",
                ref: "https://example.com/harbor/launch-plan",
                title: "Launch plan",
                addedAt: at,
                addedBy: "user",
            },
        ];
    }

    return [];
}

async function buildConfig(home: string): Promise<void> {
    const store = new MeetingsConfigStore();
    const exportFolder = (project: string) => join(home, "notes", project);

    for (const project of [NORTHWIND, HARBOR]) {
        mkdirSync(exportFolder(project), { recursive: true });
    }

    await store.update((raw) => {
        raw.global = {
            language: "en",
            capture: { activeFps: 1, retentionDays: 30 },
        };
        raw.languages = {
            en: {
                ocr: ["en-US"],
                render: { unclearLabel: "unclear", readAloudLabel: "reads from", lineLabel: "line" },
            },
        };
        raw.projects = {
            [NORTHWIND]: {
                match: { title: { words: ["northwind", "checkout"] }, calendar: { calendars: ["Northwind"] } },
                export: { folder: exportFolder(NORTHWIND) },
            },
            [HARBOR]: {
                match: { title: { words: ["harbor", "launch"] }, calendar: { calendars: ["Harbor"] } },
                export: { folder: exportFolder(HARBOR) },
            },
        };
    });
    await store.setProjectLabels(NORTHWIND, { add: ["Checkout 2.0", "Search revamp", "Release 4.2"] });
    await store.setProjectLabels(HARBOR, { add: ["Launch copy", "Photo shoot"] });
    await store.addSourceFolder("wisprflow", NORTHWIND, NORTHWIND_FOLDER);
    await store.addSourceFolder("wisprflow", HARBOR, HARBOR_FOLDER);
    await store.putDictionaryEntries({ kind: "global" }, DICTIONARY);
}

async function buildMeetings(home: string, now: Date): Promise<Array<{ seed: MeetingSeed; record: MeetingRecord }>> {
    const db = createWisprDatabase(home);
    const store = new MeetingStore();
    const made: Array<{ seed: MeetingSeed; record: MeetingRecord }> = [];

    try {
        for (const seed of SEEDS) {
            const start = startOf(seed, now);
            const end = new Date(start.getTime() + seed.durationMin * 60_000);
            const linked = Boolean(seed.transcript);
            const stamp = start.toISOString();
            let recording: RecordingBlock | undefined;

            if (seed.transcript) {
                addWisprMeeting({ db, home, seed, start, end });
            }

            if (seed.key === "debrief") {
                recording = {
                    startedAt: stamp,
                    stoppedAt: new Date(start.getTime() + 90_000).toISOString(),
                    status: "stopped",
                    stopReason: "failed",
                    backend: "native",
                    displayPolicy: "all",
                    frames: 0,
                    warning: "Screen capture stopped: the display went to sleep before the first frame.",
                    spans: [
                        { from: stamp, to: new Date(start.getTime() + 90_000).toISOString(), stopReason: "failed" },
                    ],
                };
            }

            const record = await store.create(
                {
                    title: seed.title,
                    start: stamp,
                    end: end.toISOString(),
                    createdBy: linked ? "link" : "record",
                    ...(seed.project ? { project: seed.project } : {}),
                    labels: seed.labels ?? [],
                    sources: linked
                        ? { wisprflow: { meetingId: wisprId(seed.key), folders: seed.folder ? [seed.folder] : [] } }
                        : {},
                    participants: linked
                        ? PEOPLE.map((name) => ({
                              name,
                              ...(name === ALICE ? { self: true } : {}),
                              from: ["wisprflow"],
                          }))
                        : [],
                    context: contextFor(seed.key, stamp),
                    items: itemsFor(seed.key, start, end),
                    ...(seed.key === "copy"
                        ? {
                              calendar: {
                                  from: "wisprflow",
                                  eventId: "evt-harbor-copy",
                                  calendar: "Harbor",
                                  title: seed.title,
                                  start: stamp,
                                  end: end.toISOString(),
                                  attendees: PEOPLE,
                              },
                          }
                        : {}),
                    ...(recording ? { recording } : {}),
                },
                { command: "meetings-sandbox", change: "created from the invented fixture set" }
            );

            if (seed.key === "walkthrough") {
                const frames = addFrames({ folder: store.folder(record.id), start });
                writeFileSync(join(store.folder(record.id), "ocr.jsonl"), `${frames.rows.join("\n")}\n`);
                const lastSec = FRAMES[FRAMES.length - 1]!.sec;
                const to = new Date(start.getTime() + (lastSec + 60) * 1000).toISOString();
                const updated = await store.update(
                    record.id,
                    { command: "meetings-sandbox", change: "added the screen recording" },
                    (draft) => {
                        draft.recording = {
                            startedAt: stamp,
                            stoppedAt: to,
                            status: "stopped",
                            stopReason: "requested",
                            backend: "native",
                            displayPolicy: "all",
                            displays: [{ id: 1, name: "Built-in Display", frames: FRAMES.length }],
                            framesDir: "frames",
                            ocr: "ocr.jsonl",
                            frames: FRAMES.length,
                            bytes: frames.bytes,
                            spans: [{ from: stamp, to, stopReason: "requested" }],
                            displaySpans: [{ displayId: 1, from: stamp, to, stopReason: "requested" }],
                            clock: { source: "wisprflow", startedAt: stamp },
                        };
                    }
                );
                made.push({ seed, record: updated });
                continue;
            }

            made.push({ seed, record });
        }
    } finally {
        db.close();
    }

    return made;
}

function openCommand(home: string): string {
    const tools = join(REPO_ROOT, "tools");
    const args = windowOpenArgs({ place: "needs" }, genesisAppBundlePath());
    const envFlags = [
        `GENESIS_TOOLS_HOME=${home}`,
        `HOME=${home}`,
        "GENESIS_HUB_SERVER=0",
        `GENESIS_TOOLS_BIN=${tools}`,
    ].flatMap((pair) => ["--env", pair]);
    const [first, ...rest] = args;
    const words = ["open", first!, ...envFlags, ...rest];
    const lines: string[] = [];

    for (let index = 0; index < words.length; ) {
        if (words[index] === "--env") {
            lines.push(`--env ${quote(words[index + 1]!)}`);
            index += 2;
        } else if (words[index] === "--args") {
            lines.push(words.slice(index).map(quote).join(" "));
            break;
        } else {
            lines.push(quote(words[index]!));
            index += 1;
        }
    }

    return lines.join(" \\\n    ");
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { home: { type: "string" } } });

    if (!values.home) {
        throw new Error("Usage: bun scripts/fixtures/meetings-sandbox.ts --home <dir>");
    }

    const home = resolve(values.home);
    resetHome(home);
    const now = new Date();

    await env.withScoped({ GENESIS_TOOLS_HOME: home }, async () => {
        await buildConfig(home);
        const made = await buildMeetings(home, now);
        out.println(`Sandbox home: ${home}`);
        out.println(`Meetings: ${made.length}, records in ${genesisToolsDirIn(home, "meetings")}`);

        for (const { record } of made) {
            out.println(`  ${record.id}  [${record.project ?? "no project"}]`);
        }
    });

    out.println("");
    out.println("Read it back (from a checkout):");
    out.println(`  GENESIS_TOOLS_HOME=${quote(home)} HOME=${quote(home)} ./tools meetings overview --json`);
    out.println("");
    out.println("Open the Meetings window on it (needs GenesisTools.app installed):");
    out.println(openCommand(home));
}

main().catch((err: unknown) => {
    out.log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
