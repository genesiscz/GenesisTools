import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore, meetingItemSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { readVoiceLibrary } from "@genesiscz/utils/meetings/voice-library";
import { DecisionJournal } from "../decision-journal";
import type { VoicePrintChange } from "../voice-samples";
import { MeetingVoiceJobs } from "./voice-jobs";

let previousHome: string;
beforeEach(() => {
    previousHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "receipt-rehearsal-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", previousHome));

test("P6 naming delay reads the persisted Meetings setting and defaults old configs to ten seconds", () => {
    expect(meetingsConfigSchema.parse({}).meetings.voices.reproposeDelaySec).toBe(10);
    expect(
        meetingsConfigSchema.parse({ meetings: { voices: { reproposeDelaySec: 2 } } }).meetings.voices.reproposeDelaySec
    ).toBe(2);
    expect(meetingsConfigSchema.safeParse({ meetings: { voices: { reproposeDelaySec: -1 } } }).success).toBe(false);
});

test.each(["before library", "after library", "after journal"] as const)(
    "P6 recovers after a publishing process stops %s",
    async (cut) => {
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
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { DecisionJournal } from "./src/meetings/lib/decision-journal";
            import { publishVoiceChanges } from "./src/meetings/lib/voice-samples";
            import { MeetingStore } from "./src/utils/meetings/record";
            const { cut, change } = await Bun.stdin.json();
            if (cut === "after library") publishVoiceChanges([change]);
            if (cut === "after journal") new DecisionJournal({store: new MeetingStore()})
                .publishBackfilledVoices(change.after.meeting, [change], false);
            process.kill(process.pid, "SIGKILL");
        `,
            ],
            { stdin: new Blob([SafeJSON.stringify({ cut, change })]), stdout: "ignore", stderr: "pipe" }
        );
        await child.exited;
        expect(child.signalCode).toBe("SIGKILL");
        const reopened = new DecisionJournal({ store: new MeetingStore() });
        if (cut === "before library") {
            expect(reopened.read(record.id)[0]?.voices).toBeUndefined();
            expect(readVoiceLibrary().library.samples).toEqual([]);
            // The original decision still owns this pending unit.
            reopened.publishBackfilledVoices(record.id, [change], false);
        } else {
            expect(reopened.read(record.id)[0]?.voices?.[0]?.id).toBe(readVoiceLibrary().library.samples[0]?.id);
        }
        const jobs = new MeetingVoiceJobs({ store: new MeetingStore(), notify: () => {} });
        try {
            await jobs.discover(new MeetingStore().read(record.id)!);
            const receipts = readVoiceLibrary().library.receipts.filter((r) => r.kind === "learn");
            expect(receipts).toHaveLength(1);
            expect(readFileSync(join(store.folder(record.id), "voice-backfill.ndjson"), "utf8")).toContain(
                receipts[0]!.id
            );
            await reopened.revert({ meeting: record.id, token: entry!.token, actor: { kind: "cli" } });
            expect(readVoiceLibrary().library.samples).toEqual([]);
        } finally {
            jobs.stop();
        }
    }
);
