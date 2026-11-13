import { describe, expect, it } from "bun:test";
import { needsHuman } from "../decisions/notify";
import { staleCrossings } from "../decisions/read";
import type { DecisionRecord } from "../decisions/store";
import { buildInbox } from "../inbox/build";
import type { AskForm } from "../pending/types";
import type { WaitingDialog } from "./set";
import { addressedToHuman, INBOX_STALE_MS, waitingSet, waitsOnHuman } from "./set";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (offset: number) => new Date(NOW - offset).toISOString();

function row(id: string, patch: Partial<DecisionRecord>): DecisionRecord {
    return {
        id,
        sessionId: "s-alpha",
        number: Number(id.replace(/\D/g, "")) || 1,
        prompt: `question ${id}`,
        options: ["one", "two"],
        state: "open",
        blocking: true,
        createdTs: iso(4 * HOUR),
        updatedTs: iso(4 * HOUR),
        ...patch,
    };
}

/** One fixture for every surface: each row is a case two predicates used to disagree on. */
const ROWS: DecisionRecord[] = [
    row("d1", {}),
    row("d2", { for: "fable" }),
    row("d3", { state: "drafted", draftOption: "a" }),
    row("d4", { delivery: { uncertain: true, route: "cmux", at: iso(HOUR) } }),
    row("d5", { type: "todo", for: "human", blocking: false }),
    row("d6", { type: "todo", blocking: false }),
    row("d7", { state: "answered", option: "a" }),
    row("d8", { sessionId: "s-quiet", createdTs: iso(5 * 24 * HOUR), updatedTs: iso(5 * 24 * HOUR) }),
];

const FORM: AskForm = {
    id: "form-1",
    createdAt: NOW - HOUR,
    sessionHint: "s-alpha",
    projectPath: "/tmp/gt-waiting/shop",
    cwd: "/tmp/gt-waiting/shop",
    items: [{ id: "q1", promptMarkdown: "Which port?" }],
    status: "pending",
};

describe("waiting set", () => {
    it("honours for, the states and an uncertain delivery in one rule", () => {
        expect(ROWS.filter(waitsOnHuman).map((entry) => entry.id)).toEqual(["d1", "d3", "d5", "d8"]);
        expect(addressedToHuman(row("x", { for: "Human " }))).toBe(true);
    });

    it("counts per session by its freshness and the clear watermark", () => {
        const set = waitingSet({ rows: ROWS, forms: [FORM], now: NOW });

        expect(set.items.map((item) => [item.key, item.counted])).toEqual([
            ["form-1", true],
            ["d1", true],
            ["d3", true],
            ["d5", true],
            ["d8", false],
        ]);
        expect(set.sessions.map((entry) => [entry.key, entry.waiting, entry.counted])).toEqual([
            ["s-alpha", 4, 4],
            ["s-quiet", 1, 0],
        ]);
        expect(set.total).toBe(4);

        const live = waitingSet({ rows: ROWS, forms: [FORM], now: NOW, live: new Set(["s-quiet"]) });
        expect(live.total).toBe(5);

        const cleared = waitingSet({ rows: ROWS, forms: [FORM], now: NOW, clearedAt: NOW - 2 * HOUR });
        expect(cleared.total).toBe(1);
    });

    it("gives every surface the same answer for the same rows", () => {
        const set = waitingSet({ rows: ROWS, forms: [FORM], now: NOW, activityAt: () => NOW });
        const decisionsWaiting = set.items.filter((item) => item.kind === "decision").map((item) => item.key);

        // The banner: open rows only, decisions and the todo for the human.
        expect(ROWS.filter(needsHuman).map((entry) => entry.id)).toEqual(["d1", "d5", "d8"]);
        // The stale check: blocking decisions of the set.
        const stale = staleCrossings(ROWS, { warnAfterMinutes: 60, alarmAfterMinutes: 24 * 60 }, NOW);
        expect(stale.map((crossing) => crossing.id).sort()).toEqual(
            decisionsWaiting.filter((key) => ROWS.find((entry) => entry.id === key)?.blocking).sort()
        );
        // The hub inbox lists decisions and forms (its deliberate filter: no todos); its count is the set's.
        const inbox = buildInbox({ sessions: [], scans: new Map(), rows: ROWS, forms: [FORM], now: NOW });
        const alpha = inbox.find((entry) => entry.sessionId === "s-alpha");
        const alphaSet = set.items.filter((item) => item.session === "s-alpha" && item.kind !== "todo");
        expect(alpha?.waiting).toBe(alphaSet.length);
        expect(INBOX_STALE_MS).toBe(72 * HOUR);
    });

    it("counts an old ask of a live session, which a stale session's ask does not", () => {
        const old = [row("d1", { sessionId: "s-running", createdTs: iso(100 * HOUR), updatedTs: iso(100 * HOUR) })];

        expect(waitingSet({ rows: old, now: NOW }).total).toBe(0);
        expect(waitingSet({ rows: old, now: NOW, live: new Set(["s-running"]) }).total).toBe(1);
    });

    it("holds a dialog to the clear watermark and to its session's freshness", () => {
        const dialog = (sessionId: string, offset: number): WaitingDialog => ({
            provider: "claude",
            sessionId,
            toolCallId: `call-${sessionId}`,
            askedAt: iso(offset),
        });
        const dialogs = [dialog("s-alpha", HOUR), dialog("s-quiet", 100 * HOUR)];
        const counted = (set: ReturnType<typeof waitingSet>) =>
            set.items.filter((item) => item.counted).map((item) => item.session);

        // The quiet session asked 100 hours ago and did nothing since: its dialog stays listed and does not count.
        expect(counted(waitingSet({ rows: [], dialogs, now: NOW }))).toEqual(["s-alpha"]);
        // Mark all read after the ask: the fresh session's dialog stops counting too.
        expect(counted(waitingSet({ rows: [], dialogs, now: NOW, clearedAt: NOW - HOUR / 2 }))).toEqual([]);
        // A closed dialog is not waiting at all.
        expect(waitingSet({ rows: [], dialogs: [{ ...dialogs[0], closedAt: iso(0) }], now: NOW }).items).toEqual([]);
    });

    it("counts a form asked after Mark all read alone, never with its session's cleared ones", () => {
        const form = (id: string, createdAt: number): AskForm => ({ ...FORM, id, sessionHint: "s-forms", createdAt });
        const cleared = [form("cleared-0", NOW - 3000), form("cleared-1", NOW - 2000), form("cleared-2", NOW - 1000)];

        expect(waitingSet({ rows: [], forms: cleared, now: NOW }).total).toBe(3);
        expect(waitingSet({ rows: [], forms: cleared, now: NOW, clearedAt: NOW }).total).toBe(0);

        const after = waitingSet({
            rows: [],
            forms: [...cleared, form("after-clear", NOW + 1000)],
            now: NOW + 2000,
            clearedAt: NOW,
        });
        expect(after.total).toBe(1);
        expect(after.sessions.map((entry) => [entry.key, entry.waiting, entry.counted])).toEqual([["s-forms", 4, 1]]);
    });

    it("clears every session's forms by the same watermark, however many sessions ask", () => {
        const forms = Array.from(
            { length: 258 },
            (_, index): AskForm => ({
                ...FORM,
                id: `form-${index}`,
                sessionHint: `overflow-${index}`,
                createdAt: NOW - 10_000 + index,
            })
        );
        const before = waitingSet({ rows: [], forms, now: NOW });
        const after = waitingSet({ rows: [], forms, now: NOW, clearedAt: NOW });

        expect(before.total).toBe(258);
        expect(after.total).toBe(0);
        expect(after.sessions.filter((entry) => entry.counted > 0)).toEqual([]);
    });
});
