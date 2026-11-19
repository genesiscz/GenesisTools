import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConfigStore, meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore, meetingItemSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { readVoiceLibrary } from "@genesiscz/utils/meetings/voice-library";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { setConfigValue } from "../config-edit";
import { DecisionJournal } from "../decision-journal";
import { OpenedMeeting } from "../opened-meeting";
import * as voice from "../speaker-labels/voice";
import type { VoicePrintChange } from "../voice-samples";
import type { VoiceJob } from "./api";

let previousHome: string;
beforeEach(() => {
    previousHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "receipt-rehearsal-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", previousHome));

test("P6 naming delay reads the persisted Meetings setting and defaults old configs to ten seconds", async () => {
    expect(meetingsConfigSchema.parse({}).meetings.voices.reproposeDelaySec).toBe(10);
    expect(
        meetingsConfigSchema.parse({ meetings: { voices: { reproposeDelaySec: 2 } } }).meetings.voices.reproposeDelaySec
    ).toBe(2);
    const store = new MeetingsConfigStore();
    await setConfigValue(store, "meetings.voices.reproposeDelaySec", 2);
    expect((await new MeetingsConfigStore().read()).meetings.voices.reproposeDelaySec).toBe(2);
    expect(meetingsConfigSchema.safeParse({ meetings: { voices: { reproposeDelaySec: -1 } } }).success).toBe(false);
});

async function rehearsalDecision() {
    const store = new MeetingStore();
    const project = "rehearsal";
    const person = "Iris Example";
    const at = "2026-01-10T09:00:00Z";
    const record = await store.create(
        {
            title: "Rehearsal",
            start: at,
            createdBy: "new",
            project,
            items: [
                meetingItemSchema.parse({
                    id: "i1",
                    kind: "speaker-range",
                    status: "suggested",
                    suggestedAt: at,
                    rules: [MeetingRule.VoiceEmbedding],
                    fromSec: 0,
                    toSec: 4,
                    label: "Speaker",
                    speaker: person,
                }),
            ],
        },
        { command: "fixture", change: "one speaker" }
    );
    const journal = new DecisionJournal({ store });
    const { entry } = await journal.apply({
        meeting: record.id,
        actor: { kind: "cli" },
        action: { kind: "confirm", items: ["i1"] },
    });
    const change: VoicePrintChange = {
        project,
        person,
        token: entry!.token,
        item: "i1",
        origin: "confirm",
        acquiredBy: "live",
        model: "test-model",
        after: {
            meeting: record.id,
            sourceSha: "fixture",
            fromSec: 0,
            toSec: 4,
            seat: "mic",
            track: "source-mic",
            embedding: [1, 0],
            confirmedAt: entry!.at,
            question: "i1",
        },
    };
    return { store, record, change };
}

function rehearsalAudio(store: MeetingStore, record: MeetingRecord, canEmbed: boolean) {
    const audio = join(store.folder(record.id), "rehearsal.wav");
    writeFileSync(audio, "one voice");
    const opened = OpenedMeeting.of(store, record);
    const spies = [
        spyOn(OpenedMeeting, "of").mockReturnValue(opened),
        spyOn(opened, "meeting").mockResolvedValue({
            sourceMeetingId: "rehearsal",
            title: "Rehearsal",
            start: record.start,
            participants: [],
            speakers: [],
            folders: [],
            transcript: [
                { speaker: "Speaker", text: "One line", startSec: 0 },
                { speaker: "Speaker", text: "Next line", startSec: 4 },
            ],
        }),
        spyOn(opened, "evidence").mockResolvedValue({
            segments: [{ startSec: 0, endSec: 10, channel: "mic" }],
            speaking: [],
            files: [],
        }),
        spyOn(opened, "energy").mockResolvedValue({}),
        spyOn(opened, "sound").mockResolvedValue({ tracks: [], slice: () => undefined }),
    ];
    const embed = spyOn(voice, "embedSeatLines").mockImplementation(async ({ lines }) => {
        if (!canEmbed) {
            throw new Error("Recovery must use its committed receipt");
        }
        return lines.map((line) => ({
            ...line,
            track: "source-mic",
            channels: [
                {
                    model: "test-model",
                    track: "raw-mic",
                    channel: 0,
                    fromSec: line.fromSec,
                    toSec: line.toSec,
                    quality: "ready",
                    embedding: [1, 0],
                    source: { audioPath: audio, size: statSync(audio).size, mtimeMs: statSync(audio).mtimeMs },
                },
            ],
        }));
    });
    return {
        embed,
        restore() {
            embed.mockRestore();
            for (const spy of spies.reverse()) {
                spy.mockRestore();
            }
        },
    };
}

test.each(["before library", "after library", "after journal"] as const)(
    "P6 recovers after a publishing process stops %s",
    async (cut) => {
        const { store, record, change } = await rehearsalDecision();
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { existsSync } from "node:fs";
            import { join } from "node:path";
            import { atomicWriteIo } from "./src/utils/storage/atomic-file";
            import { DecisionJournal } from "./src/meetings/lib/decision-journal";
            import { MeetingStore } from "./src/utils/meetings/record";
            const { cut, change } = await Bun.stdin.json();
            class StoppingJournal extends DecisionJournal {
                appendVoiceReceipts(meeting, rows) {
                    if (cut === "after library") process.kill(process.pid, "SIGKILL");
                    super.appendVoiceReceipts(meeting, rows);
                    if (cut === "after journal") process.kill(process.pid, "SIGKILL");
                }
            }
            const store = new MeetingStore();
            await store.withRecords({ ids: [change.after.meeting], fn: async () => {
                if (cut === "before library") {
                    const write = atomicWriteIo.writeSync;
                    atomicWriteIo.writeSync = (...args) => {
                        if (existsSync(join(store.folder(change.after.meeting), "voice-learning-pending.json"))) {
                            process.kill(process.pid, "SIGKILL");
                        }
                        return write(...args);
                    };
                }
                new StoppingJournal({store}).publishBackfilledVoices(change.after.meeting, [change], false);
                throw new Error("Publication returned without reaching the requested crash point");
            } });
        `,
            ],
            {
                stdin: new Blob([SafeJSON.stringify({ cut, change })]),
                stdout: "ignore",
                stderr: "pipe",
                // The child's store must be this test's home; without it the child opened the real meetings store.
                env: { ...process.env, GENESIS_TOOLS_HOME: env.tools.getHome() },
            }
        );
        await child.exited;
        expect(child.signalCode).toBe("SIGKILL");
        expect(existsSync(join(store.folder(record.id), "voice-learning-pending.json"))).toBe(true);
        expect(existsSync(join(store.folder(record.id), "voice-backfill.ndjson"))).toBe(cut === "after journal");
        const reopened = new DecisionJournal({ store: new MeetingStore() });
        if (cut === "before library") {
            expect(reopened.read(record.id)[0]?.voices).toBeUndefined();
            expect(readVoiceLibrary().library.samples).toEqual([]);
        } else {
            expect(reopened.read(record.id)[0]?.voices?.[0]?.id).toBe(readVoiceLibrary().library.samples[0]?.id);
        }
        const { embed, restore } = rehearsalAudio(store, record, cut === "before library");
        const { MeetingVoiceJobs } = await import("./voice-jobs");
        const jobs = new MeetingVoiceJobs({ store: new MeetingStore(), notify: () => {} });
        try {
            await jobs.discover(new MeetingStore().read(record.id)!);
            expect(embed).toHaveBeenCalledTimes(cut === "before library" ? 1 : 0);
            const receipts = readVoiceLibrary().library.receipts.filter((r) => r.kind === "learn");
            expect(receipts).toHaveLength(1);
            expect(readFileSync(join(store.folder(record.id), "voice-backfill.ndjson"), "utf8")).toContain(
                receipts[0]!.id
            );
            await reopened.revert({ meeting: record.id, token: change.token!, actor: { kind: "cli" } });
            expect(readVoiceLibrary().library.samples).toEqual([]);
        } finally {
            jobs.stop();
            restore();
        }
    }
);

test.each(["releases", "times out"] as const)(
    "P6 publication waits for a live library writer that %s",
    async (outcome) => {
        const { store, record } = await rehearsalDecision();
        const { embed, restore } = rehearsalAudio(store, record, true);
        const waiting = Promise.withResolvers<void>();
        const events: VoiceJob[] = [];
        const { MeetingVoiceJobs } = await import("./voice-jobs");
        const jobs = new MeetingVoiceJobs({
            store: new MeetingStore(),
            notify: (job) => {
                events.push(job);
                if (job.progress.step === "Waiting for the voice library") {
                    waiting.resolve();
                }
            },
        });
        try {
            const lock = toolDataDir("meetings", "voice-library", "library.json.claim-arbitration.lock");
            const held = await withFileLock(lock, async () => {
                const publication = jobs.discover(store.read(record.id)!);
                if (!publication) {
                    throw new Error("Expected the confirmed decision to start a job");
                }
                if (outcome === "releases") {
                    await Promise.race([
                        waiting.promise,
                        publication.then(() => {
                            throw new Error("Publication finished while another writer held the library");
                        }),
                    ]);
                } else {
                    await expect(publication).rejects.toThrow("Learning remains pending for the next service start");
                    expect(events.at(-1)?.state).toBe("failed");
                }
                expect(events.some((event) => event.progress.step === "Waiting for the voice library")).toBe(true);
                expect(events.some((event) => event.state === "done")).toBe(false);
                expect(embed).toHaveBeenCalledTimes(1);
                expect(existsSync(join(store.folder(record.id), "voice-learning-pending.json"))).toBe(true);
                expect(readVoiceLibrary().library.samples).toHaveLength(0);
                return { publication };
            });
            if (outcome === "releases") {
                await held.publication;
                expect(events.at(-1)?.state).toBe("done");
                expect(embed).toHaveBeenCalledTimes(1);
            } else {
                jobs.stop();
                const next = new MeetingVoiceJobs({ store: new MeetingStore(), notify: () => {} });
                try {
                    await next.discover(new MeetingStore().read(record.id)!);
                    expect(next.list()[0]?.state).toBe("done");
                } finally {
                    next.stop();
                }
            }
            const { library } = readVoiceLibrary();
            expect(library.samples).toHaveLength(1);
            expect(library.receipts.filter((receipt) => receipt.kind === "learn")).toHaveLength(1);
            const reopen = new DecisionJournal({ store: new MeetingStore() });
            expect(reopen.read(record.id)[0]?.voices?.map((voice) => voice.id)).toEqual([library.samples[0]!.id]);
            expect(
                readFileSync(join(store.folder(record.id), "voice-backfill.ndjson"), "utf8")
                    .trim()
                    .split("\n")
            ).toHaveLength(1);
            expect(existsSync(join(store.folder(record.id), "voice-learning-pending.json"))).toBe(false);
        } finally {
            jobs.stop();
            restore();
        }
    },
    15_000
);
