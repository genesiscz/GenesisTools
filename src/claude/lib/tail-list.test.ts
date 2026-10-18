import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@genesiscz/utils/claude/session.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";

// The statusline folder is ~/.claude/statusline, resolved at import time. Point the home at a temp folder first.
const home = mkdtempSync(join(realOs.tmpdir(), "gt-tail-list-"));
mock.module("node:os", () => ({ ...realOs, homedir: () => home }));
const { ClaudeSession } = await import("@genesiscz/utils/claude/session");
const { getActiveSessionIds, renderActiveSessionList, renderSessionList } = await import("./tail-list");

type Row = Record<string, unknown>;

const statuslineDir = join(home, ".claude", "statusline");
const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_C = "cccccccc-0000-4000-8000-000000000003";
const MINUTE = 60_000;

function envelope(extra: Row = {}): Row {
    return {
        uuid: "u",
        parentUuid: null,
        sessionId: ID_A,
        timestamp: "2026-03-01T10:00:00.000Z",
        userType: "external",
        ...extra,
    };
}

function userRow(content: unknown, extra: Row = {}): Row {
    return { type: "user", ...envelope(extra), message: { role: "user", content } };
}

function assistantRow(value: string): Row {
    return {
        type: "assistant",
        ...envelope(),
        message: {
            role: "assistant",
            id: "m",
            type: "message",
            model: "claude-test-1",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: "text", text: value }],
        },
    };
}

function writeJsonl(name: string, lines: Array<Row | string>): string {
    const path = join(home, "transcripts", name);
    mkdirSync(join(home, "transcripts"), { recursive: true });
    writeFileSync(
        path,
        `${lines.map((line) => (typeof line === "string" ? line : SafeJSON.stringify(line))).join("\n")}\n`
    );
    return path;
}

function info(overrides: Partial<SessionInfo> & Pick<SessionInfo, "filePath">): SessionInfo {
    return {
        sessionId: ID_A,
        title: null,
        summary: null,
        gitBranch: null,
        project: null,
        startDate: null,
        lastTimestamp: null,
        fileSize: 100,
        messageCount: 1,
        isSubagent: false,
        ...overrides,
    };
}

let pathA: string;
let pathB: string;
let pathC: string;

beforeAll(() => {
    pathA = writeJsonl("a.jsonl", [
        userRow("<system-reminder>ignore me</system-reminder>First question"),
        assistantRow("Answer one"),
        userRow("injected by the harness", { isMeta: true }),
        "this line is not json",
        SafeJSON.stringify({ note: "a record without a type" }),
        userRow("Latest question\nwith a second line"),
        assistantRow("Excerpt two"),
        assistantRow("Excerpt three"),
        { type: "A", message: { role: "assistant", content: [{ type: "text", text: "Excerpt four" }] } },
    ]);
    pathB = writeJsonl("b.jsonl", [userRow("Only question")]);
    pathC = writeJsonl(
        "c.jsonl",
        Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? userRow(`question ${i}`) : assistantRow(`reply ${i}`)))
    );
});

afterAll(() => {
    rmSync(home, { recursive: true, force: true });
});

const printed: string[] = [];
let println: ReturnType<typeof spyOn<typeof out, "println">>;

beforeEach(() => {
    printed.length = 0;
    println = spyOn(out, "println").mockImplementation((raw?: unknown) => {
        printed.push(raw === undefined ? "" : stripAnsi(String(raw)));
    });
});

afterEach(() => {
    println.mockRestore();
});

describe("getActiveSessionIds", () => {
    it("is empty when there is no statusline folder", () => {
        rmSync(statuslineDir, { recursive: true, force: true });

        expect(getActiveSessionIds().size).toBe(0);
    });

    it("lists sessions whose state file changed within the last 15 minutes", () => {
        mkdirSync(statuslineDir, { recursive: true });
        const touch = (name: string, ageMs: number) => {
            const path = join(statuslineDir, name);
            writeFileSync(path, "");
            const when = (Date.now() - ageMs) / 1000;
            utimesSync(path, when, when);
        };
        touch(`statusline.${ID_A}.state`, MINUTE);
        touch(`statusline.${ID_B}.state`, 20 * MINUTE);
        touch(`statusline.${ID_C}.json`, MINUTE);
        touch("other.state", MINUTE);

        expect([...getActiveSessionIds()]).toEqual([ID_A]);
    });
});

describe("renderSessionList", () => {
    it("says so when there are no sessions, and asks only for the newest 15 of the project", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([]);

        try {
            await renderSessionList({ level: 1, project: "acme", colors: false });

            expect(printed).toEqual(["No sessions found."]);
            expect(find).toHaveBeenCalledWith({ project: "acme", limit: 15 });
        } finally {
            find.mockRestore();
        }
    });

    it("prints a compact list, newest first, with the last question and the last two answers", async () => {
        const now = Date.now();
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({
                filePath: pathB,
                sessionId: ID_B,
                summary: "Older summary",
                lastTimestamp: new Date(now - 3 * 86_400_000),
            }),
            info({
                filePath: pathA,
                sessionId: ID_A,
                title: "Invoice work",
                gitBranch: "feat/invoices",
                lastTimestamp: new Date(now - 5 * MINUTE),
            }),
        ]);

        try {
            await renderSessionList({ level: 1, colors: false });
        } finally {
            find.mockRestore();
        }

        const text = printed.join("\n");
        const newest = printed.findIndex((line) => line.includes("aaaaaaaa"));
        const older = printed.findIndex((line) => line.includes("bbbbbbbb"));

        expect(printed.some((line) => line.includes("Sessions"))).toBe(true);
        expect(printed.some((line) => line.includes("recent Claude Code sessions"))).toBe(true);
        expect(newest).toBeGreaterThan(-1);
        expect(older).toBeGreaterThan(newest);
        expect(printed[newest]).toMatch(/^ {2}● aaaaaaaa {2}5m ago {2}feat\/invoices {2}Invoice work$/);
        expect(printed[newest + 1]).toBe("   › Latest question with a second line");
        expect(printed[newest + 2]).toBe("   │ Excerpt three");
        expect(printed[newest + 3]).toBe("   │ Excerpt four");
        expect(text).not.toContain("First question");
        expect(text).not.toContain("injected by the harness");
        expect(printed[older]).toMatch(/^ {2}● bbbbbbbb {2}3d ago {2}Older summary$/);
        expect(printed[older + 1]).toBe("   › Only question");
        expect(printed.some((line) => /^ {2}2 sessions {2}· {2}.*tail aaaaaaaa.* to tail$/.test(line))).toBe(true);
    });

    it("shows a placeholder for a session without a date or id and no tail hint", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({ filePath: pathB, sessionId: null }),
        ]);

        try {
            await renderSessionList({ level: 1, colors: false });
        } finally {
            find.mockRestore();
        }

        expect(printed.some((line) => /^ {2}● unknown {2}— {2}$/.test(line) || line === "  ● unknown  —")).toBe(true);
        expect(printed.some((line) => line.includes("to tail"))).toBe(false);
    });

    it("shows the age of a session from a few hours ago in hours", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({ filePath: pathB, sessionId: ID_B, lastTimestamp: new Date(Date.now() - 3 * 3_600_000) }),
        ]);

        try {
            await renderSessionList({ level: 1, colors: false });
        } finally {
            find.mockRestore();
        }

        expect(printed.some((line) => /^ {2}● bbbbbbbb {2}3h ago$/.test(line))).toBe(true);
    });

    it("cuts a long title to 40 characters and singularises the count", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({ filePath: pathB, sessionId: ID_B, title: "t".repeat(60), lastTimestamp: new Date() }),
        ]);

        try {
            await renderSessionList({ level: 1, colors: false });
        } finally {
            find.mockRestore();
        }

        expect(printed.some((line) => line.endsWith(`${"t".repeat(37)}...`))).toBe(true);
        expect(printed.some((line) => line.includes("1 session  ·"))).toBe(true);
    });

    it("prints the verbose list with the tail hint and the active marker", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({
                filePath: pathA,
                sessionId: ID_A,
                gitBranch: "feat/invoices",
                lastTimestamp: new Date(Date.now() - 5 * MINUTE),
            }),
            info({ filePath: pathB, sessionId: ID_B, lastTimestamp: new Date(Date.now() - 2 * 86_400_000) }),
        ]);

        try {
            await renderSessionList({ level: 2, colors: false });
        } finally {
            find.mockRestore();
        }

        expect(printed[0]).toMatch(/^ {2}┌ .*tail aaaaaaaa$/);
        expect(printed[1]).toBe("  └");
        expect(printed[2]).toBe("");
        expect(printed[3]).toMatch(/^🟢 aaaaaaaa {2}5m ago {3}feat\/invoices$/);
        expect(printed).toContain("   🧑 Latest question with a second line");
        expect(printed).toContain("   🤖 Excerpt two");
        expect(printed).toContain("   🤖 Excerpt three");
        expect(printed).toContain("   🤖 Excerpt four");
        expect(printed.some((line) => /^ {3}bbbbbbbb {2}2d ago/.test(line))).toBe(true);
        expect(printed).toContain("   🧑 Only question");
    });

    it("shows only the last eight conversation records of each session in the verbose list", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({ filePath: pathC, sessionId: ID_C }),
        ]);

        try {
            await renderSessionList({ level: 2, colors: true });
        } finally {
            find.mockRestore();
        }

        const shown = printed.filter((line) => line.startsWith("   🧑") || line.startsWith("   🤖"));

        expect(shown).toEqual([
            "   🧑 question 4",
            "   🤖 reply 5",
            "   🧑 question 6",
            "   🤖 reply 7",
            "   🧑 question 8",
            "   🤖 reply 9",
            "   🧑 question 10",
            "   🤖 reply 11",
        ]);
        expect(printed.some((line) => /^ {2}┌ /.test(line))).toBe(true);
        expect(printed.some((line) => /^ {3}cccccccc {2}\? +$/.test(line))).toBe(true);
    });

    it("prints no tail hint header when the newest session has no id", async () => {
        const find = spyOn(ClaudeSession, "findSessions").mockResolvedValue([
            info({ filePath: pathB, sessionId: null }),
        ]);

        try {
            await renderSessionList({ level: 2, colors: false });
        } finally {
            find.mockRestore();
        }

        expect(printed.some((line) => line.includes("┌"))).toBe(false);
        expect(printed.some((line) => line.includes("unknown"))).toBe(true);
    });
});

describe("renderActiveSessionList", () => {
    it("prints nothing when no session is active", async () => {
        await renderActiveSessionList([], new Set(), { level: 1, colors: false });

        expect(printed).toEqual([]);
    });

    it("prints a header with the count and the active sessions, newest first", async () => {
        const now = Date.now();

        await renderActiveSessionList(
            [
                info({ filePath: pathB, sessionId: ID_B, lastTimestamp: new Date(now - 10 * MINUTE) }),
                info({ filePath: pathA, sessionId: ID_A, startDate: new Date(now - 2 * MINUTE) }),
            ],
            new Set([ID_A, ID_B]),
            { level: 1, colors: false }
        );

        const first = printed.findIndex((line) => line.includes("aaaaaaaa"));
        const second = printed.findIndex((line) => line.includes("bbbbbbbb"));

        expect(printed.some((line) => line.includes("Active Sessions"))).toBe(true);
        expect(printed.some((line) => line.includes("2 running — pick one"))).toBe(true);
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
    });
});
