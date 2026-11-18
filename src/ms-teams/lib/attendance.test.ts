import { describe, expect, spyOn, test } from "bun:test";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { registerMeetingsCommand } from "../commands/meetings";
import { buildMeetingAttendance, intervalsFromEvents, observerFromEvents, parseCallEndedMessage } from "./attendance";
import * as cacheModule from "./cache";
import { parseCallLogFile, parseCallLogMessage } from "./call-log";
import { TeamsCache } from "./store";
import type { CallLogEvent, ConversationRow } from "./types";

const CALL = "11111111-2222-3333-4444-555555555555";
const THREAD = "19:meeting_fixture@thread.v2";
const ME = "8:orgid:00000000-0000-0000-0000-0000000000aa";
const ADA = "8:orgid:00000000-0000-0000-0000-0000000000a1";
const BOB = "8:teamsvisitor:00000000000000000000000000000b0b";
const t = (hhmmss: string) => Date.parse(`2026-03-02T${hhmmss}Z`);

describe("attendance candidate output", () => {
    const title = "Paper Kite Review";
    const newer = "19:meeting_kite_new@thread.v2";
    const older = "19:meeting_kite_old@thread.v2";
    const date = "2026-03-02T10:00:00.000Z";

    function runAttendance(query: string, json = false) {
        const cache = new TeamsCache(":memory:");
        const chat = (id: string, topic: string, lastMessageTimeUtc: number) => ({
            id,
            type: "meeting",
            threadProperties: { topic },
            lastMessageTimeUtc,
            members: [{ id: "kite-1" }, { id: "kite-2" }],
        });
        const weekly = Array.from({ length: 10 }, (_, i) => chat(`weekly-${i}`, "Pocket Atlas", 100 - i));
        cache.ingestDump({
            conversations: [
                chat(older, title, 200),
                chat(newer, title, 100),
                { ...chat("ordinary-chat", title, 300), type: "Chat" },
                ...weekly,
            ],
            profiles: [],
            calls: [{ id: "kite-call", groupChatThreadId: newer, startTime: date }],
            replychains: [
                {
                    conversationId: older,
                    messageMap: {
                        call: { id: "old-call", messageType: "Event/Call", originalArrivalTime: t("09:00:00") },
                    },
                },
            ],
            activity: [],
        });
        cache.ingestCallLogEvents(
            weekly.slice(1).map((row, i) => ({
                kind: "thread-link",
                threadId: row.id,
                callId: `atlas-call-${i}`,
                at: t("10:00:00") + i * 1000,
            }))
        );
        const open = spyOn(cacheModule, "openCache").mockReturnValue(cache);
        const chunks: string[] = [];
        const stdout = spyOn(process.stdout, "write").mockImplementation(
            (chunk: string | Uint8Array, ...args: unknown[]) => {
                chunks.push(String(chunk));
                const done = args.at(-1);
                if (typeof done === "function") {
                    done();
                }
                return true;
            }
        );
        const saved = process.exitCode;
        try {
            process.exitCode = undefined;
            const program = new Command();
            registerMeetingsCommand(program);
            program.parse(["meetings", "attendance", query, ...(json ? ["--json"] : [])], { from: "user" });
            return { exitCode: process.exitCode, stdout: chunks.join("") };
        } finally {
            process.exitCode = saved;
            stdout.mockRestore();
            open.mockRestore();
        }
    }

    test("prints both matching meeting chats, newest call first, with full retry commands and exit 1", () => {
        const result = runAttendance(title);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(title);
        expect(result.stdout).toContain(formatLocalDateTimeStamp(date));
        expect(result.stdout).toContain("2 participants");
        for (const id of [newer, older]) {
            expect(result.stdout).toContain(`tools ms-teams meetings attendance --id ${id}`);
        }
        expect(result.stdout.indexOf(newer)).toBeLessThan(result.stdout.indexOf(older));
        expect(result.stdout).not.toContain("ordinary-chat");
    });

    test("returns both candidates as JSON with actual call dates and chat participant counts", () => {
        const result = runAttendance(title, true);
        expect(result.exitCode).toBe(1);
        const candidates = [newer, older].map((id, i) => ({
            id,
            title,
            lastCallAt: i === 0 ? date : new Date(t("09:00:00")).toISOString(),
            participantCount: 2,
            command: `tools ms-teams meetings attendance --id ${id}`,
        }));
        expect(SafeJSON.parse(result.stdout, { strict: true })).toEqual({ status: "ambiguous", candidates });
    });

    test("limits after ranking by call date and gives a missing query an empty candidate list", () => {
        const top = runAttendance("Pocket Atlas", true);
        expect(top.exitCode).toBe(1);
        const rows = SafeJSON.parse(top.stdout, { strict: true }).candidates;
        expect(rows.map((row: { id: string }) => row.id)).toEqual(
            Array.from({ length: 8 }, (_, i) => `weekly-${9 - i}`)
        );
        const missing = runAttendance("Glass Orchard", true);
        expect(missing.exitCode).toBe(1);
        expect(SafeJSON.parse(missing.stdout, { strict: true })).toEqual({ status: "none", candidates: [] });
    });
});

describe("parseCallLogMessage", () => {
    test("reads participant added across the line break Teams puts in it", () => {
        const message = `callingParticipantService: participant added: ${ADA}, [spotlighted=false]\n      [teamsCallId=1][callId=${CALL}]`;
        expect(parseCallLogMessage(message, 1)).toEqual({ kind: "participant-added", callId: CALL, at: 1, mri: ADA });
    });

    test("reads removed, own call state and the call to thread link", () => {
        expect(
            parseCallLogMessage(
                `callingParticipantService: participant removed: ${BOB}, [teamsCallId=1] [callId=${CALL}]`,
                2
            )
        ).toEqual({ kind: "participant-removed", callId: CALL, at: 2, mri: BOB });
        expect(
            parseCallLogMessage(
                `callingService: callingService.onCallStateChanged: callId = ${CALL} to state = Connected, [call]`,
                3
            )
        ).toEqual({ kind: "self-state", callId: CALL, at: 3, state: "Connected" });
        expect(parseCallLogMessage(`chat: callId ${CALL}, conversationId ${THREAD}, rootMessageId 0`, 4)).toEqual({
            kind: "thread-link",
            callId: CALL,
            at: 4,
            threadId: THREAD,
        });
    });

    test("ignores lines without an attendance fact", () => {
        expect(parseCallLogMessage(`ProductionStudioMixin: Participant added: id=${ADA}`, 5)).toBeNull();
    });

    test("parses a log file body and skips lines without a time", () => {
        const body = `{"logsArray":[{"message":"callingParticipantService: participant removed: ${ADA}, [callId=${CALL}]","timeStamp":"2026-03-02T10:00:00.000Z"},{"message":"callId x","timeStamp":"bad"}]}`;
        expect(parseCallLogFile(body)).toEqual([
            { kind: "participant-removed", callId: CALL, at: t("10:00:00"), mri: ADA },
        ]);
    });
});

describe("parseCallEndedMessage", () => {
    test("reads the call id, the participant list and the UTC times of a callEnded message", () => {
        const html = `<ended/><partlist alt="" count="2"><part identity="${ADA}"><name>${ADA}</name><displayName>Ada Lovelace</displayName><duration>60</duration></part><part identity="${BOB}"><name>${BOB}</name><displayName>Bob</displayName><duration>60</duration></part></partlist><meetingDetails><meetingDetails><organizerUpn>ada@example.com</organizerUpn><startTime>03/02/2026 10:00:00</startTime><endTime>03/02/2026 11:00:00</endTime></meetingDetails></meetingDetails><callEventType>callEnded</callEventType><conversationStartTime>03/02/2026 09:59:30</conversationStartTime><callId>${CALL.toUpperCase()}</callId>`;
        const record = parseCallEndedMessage({ html, originalArrivalTime: t("11:05:00") });

        expect(record).toEqual({
            callId: CALL,
            endedAt: t("11:05:00"),
            startedAt: t("09:59:30"),
            organizer: "ada@example.com",
            scheduledStart: t("10:00:00"),
            scheduledEnd: t("11:00:00"),
            participants: [
                { id: ADA, name: "Ada Lovelace" },
                { id: BOB, name: "Bob" },
            ],
        });
    });

    test("is null for a call-started message", () => {
        expect(parseCallEndedMessage({ html: "<started/><callId>x</callId>", originalArrivalTime: 0 })).toBeNull();
    });
});

describe("intervalsFromEvents", () => {
    const events: CallLogEvent[] = [
        { kind: "participant-added", callId: CALL, at: t("10:00:00"), mri: ADA },
        { kind: "self-state", callId: CALL, at: t("10:00:01"), state: "Connected" },
        { kind: "participant-added", callId: CALL, at: t("10:05:00"), mri: BOB },
        { kind: "participant-removed", callId: CALL, at: t("10:20:00"), mri: BOB },
        { kind: "participant-added", callId: CALL, at: t("10:30:00"), mri: BOB },
        { kind: "self-state", callId: CALL, at: t("10:50:00"), state: "Disconnected" },
    ];

    test("marks a person already present at the observer's join and opens a new interval on a rejoin", () => {
        const observer = observerFromEvents(events);
        const intervals = intervalsFromEvents(events, observer);

        expect(observer).toEqual({ joinedAt: t("10:00:01"), leftAt: t("10:50:00") });
        expect(intervals).toEqual([
            { mri: ADA, joinedAt: t("10:00:00"), leftAt: null, joinedAtExact: false },
            { mri: BOB, joinedAt: t("10:05:00"), leftAt: t("10:20:00"), joinedAtExact: true },
            { mri: BOB, joinedAt: t("10:30:00"), leftAt: null, joinedAtExact: true },
        ]);
    });

    test("builds attendance from stored events alone, after the live log has rotated away", () => {
        const cache = new TeamsCache(":memory:");
        cache.setMeta("me_mri", ME);
        cache.ingestCallLogEvents([
            { kind: "thread-link", callId: CALL, at: t("10:00:01"), threadId: THREAD },
            ...events,
        ]);
        const conversation: ConversationRow = {
            id: THREAD,
            type: "meeting",
            title: "Fixture sync",
            topic: null,
            membersJson: `[{"mri":"${ADA}","displayName":"Ada Lovelace","email":"ada@example.com"}]`,
            lastMessageTime: null,
            lastPreview: null,
            memberCount: 1,
        };

        const [record] = buildMeetingAttendance({ cache, conversation, liveEvents: [] });
        cache.close();

        expect(record.meeting.callId).toBe(CALL);
        expect(
            record.attendance.map((r) => [
                r.name,
                r.email,
                r.self,
                Date.parse(r.joinedAt ?? ""),
                r.joinedAtExact,
                r.leftAtExact,
            ])
        ).toEqual([
            [ME, null, true, t("10:00:01"), true, true],
            ["Ada Lovelace", "ada@example.com", false, t("10:00:00"), false, false],
            [BOB, null, false, t("10:05:00"), true, true],
            [BOB, null, false, t("10:30:00"), true, false],
        ]);
        expect(Date.parse(record.attendance[1].leftAt ?? "")).toBe(t("10:50:00"));
    });
});

test("observer rejoins produce separate self and remote attendance intervals", () => {
    const cache = new TeamsCache(":memory:");
    cache.setMeta("me_mri", ME);
    const events: CallLogEvent[] = [
        { kind: "thread-link", callId: CALL, at: 1000, threadId: THREAD },
        { kind: "self-state", callId: CALL, at: 1000, state: "Connected" },
        { kind: "participant-added", callId: CALL, at: 1100, mri: ADA },
        { kind: "self-state", callId: CALL, at: 2000, state: "Disconnected" },
        { kind: "self-state", callId: CALL, at: 3000, state: "Connected" },
        { kind: "participant-added", callId: CALL, at: 3100, mri: ADA },
    ];
    const [record] = buildMeetingAttendance({
        cache,
        liveEvents: events,
        conversation: {
            id: THREAD,
            type: "meeting",
            title: "Fixture",
            topic: null,
            membersJson: "[]",
            lastMessageTime: null,
            lastPreview: null,
            memberCount: 1,
        },
    });
    cache.close();
    const self = record!.attendance.filter((row) => row.self);
    expect(self).toHaveLength(2);
    expect(self.map((row) => (row.leftAt === null ? null : Date.parse(row.leftAt)))).toEqual([2000, null]);
    const remote = record!.attendance.filter((row) => !row.self);
    expect(remote).toHaveLength(2);
    expect(remote.map((row) => Date.parse(row.joinedAt!))).toEqual([1100, 3100]);
    expect(remote.map((row) => (row.leftAt === null ? null : Date.parse(row.leftAt)))).toEqual([2000, null]);
});
