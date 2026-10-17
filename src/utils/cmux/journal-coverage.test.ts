import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readers from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    describeJournalCoverage,
    describeJournalJoin,
    journalCoverage,
    journalCoverageWarning,
} from "./journal-coverage";

const DAY = 24 * 60 * 60 * 1000;

function journal(lines: Record<string, unknown>[]): string {
    const path = join(mkdtempSync(join(tmpdir(), "cmux-journal-coverage-")), "cmux-refs.jsonl");
    writeFileSync(path, lines.map((line) => `${SafeJSON.stringify(line)}\n`).join(""));

    return path;
}

function record(sessionId: string, surfaceId: string | null, extra: Record<string, unknown> = {}) {
    return { sessionId, surfaceId, workspaceId: null, at: Date.now() - 1000, ...extra };
}

describe("journalCoverage", () => {
    test("counts the live tabs the journal names and lists the agent tabs it does not", () => {
        const refsPath = journal([
            record("11111111-1111-4111-8111-111111111111", "AAAA-1"),
            record("22222222-2222-4222-8222-222222222222", "bbbb-2", { ended: true }),
            // Too old for any reader: this tab is not recorded.
            record("33333333-3333-4333-8333-333333333333", "cccc-3", { at: Date.now() - 9 * DAY }),
            // A record without a surface places no tab.
            record("44444444-4444-4444-8444-444444444444", null),
        ]);

        const coverage = journalCoverage({
            refsPath,
            tabs: [
                { surfaceId: "aaaa-1", agent: true, label: "surface:1" },
                { surfaceId: "BBBB-2", agent: true, label: "surface:2" },
                { surfaceId: "cccc-3", agent: true, label: "surface:3" },
                { surfaceId: "dddd-4", agent: true, label: "surface:4" },
                { surfaceId: "eeee-5", agent: false, label: "surface:5" },
                { surfaceId: "dddd-4", agent: true, label: "surface:4 again" },
            ],
        });

        expect(coverage).toEqual({
            tabs: 5,
            recorded: 2,
            agentTabs: 4,
            unrecordedAgentTabs: ["surface:3", "surface:4"],
        });
    });

    test("a missing journal records nothing, and a tab with no label is named by its UUID", () => {
        const refsPath = join(mkdtempSync(join(tmpdir(), "cmux-journal-coverage-")), "none.jsonl");

        expect(journalCoverage({ refsPath, tabs: [{ surfaceId: "ffff-6", agent: true }] })).toEqual({
            tabs: 1,
            recorded: 0,
            agentTabs: 1,
            unrecordedAgentTabs: ["ffff-6"],
        });
        expect(journalCoverage({ refsPath, tabs: [] })).toEqual({
            tabs: 0,
            recorded: 0,
            agentTabs: 0,
            unrecordedAgentTabs: [],
        });
    });
});

describe("journal coverage text", () => {
    test("the doctor line says how many tabs and agent tabs are recorded", () => {
        expect(describeJournalCoverage({ tabs: 14, recorded: 12, agentTabs: 5, unrecordedAgentTabs: ["a", "b"] })).toBe(
            "12 of 14 live tabs have a surface-journal record; 2 of 5 agent tabs have none"
        );
        expect(describeJournalCoverage({ tabs: 1, recorded: 1, agentTabs: 1, unrecordedAgentTabs: [] })).toBe(
            "1 of 1 live tab has a surface-journal record; the agent tab is recorded"
        );
        expect(describeJournalCoverage({ tabs: 4, recorded: 3, agentTabs: 3, unrecordedAgentTabs: ["x"] })).toBe(
            "3 of 4 live tabs have a surface-journal record; 1 of 3 agent tabs has none"
        );
        expect(describeJournalCoverage({ tabs: 3, recorded: 0, agentTabs: 0, unrecordedAgentTabs: [] })).toBe(
            "0 of 3 live tabs have a surface-journal record; no agent runs in a tab now"
        );
    });

    test("the list warning appears only when an agent tab has no record, and caps the labels it names", () => {
        expect(journalCoverageWarning({ tabs: 2, recorded: 2, agentTabs: 2, unrecordedAgentTabs: [] })).toBeNull();
        expect(
            journalCoverageWarning({ tabs: 3, recorded: 1, agentTabs: 2, unrecordedAgentTabs: ["surface:12"] })
        ).toBe(
            "No surface-journal record for 1 live agent tab (surface:12). A restore cannot place its agent. Run `claude plugin list` to check that the hook loaded."
        );

        const many = journalCoverageWarning({
            tabs: 9,
            recorded: 0,
            agentTabs: 7,
            unrecordedAgentTabs: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
        });

        expect(many).toContain("7 live agent tabs (s1, s2, s3, s4, s5, and 2 more)");
        expect(many).toContain("their agents");
    });
});

test("an unreadable journal makes coverage unavailable rather than accusing the hook of missing records", () => {
    const refsPath = journal([record("fixture-session", "surface-1")]);
    const error = Object.assign(new Error("fixture journal permission denied"), { code: "EACCES" });
    const reader = spyOn(readers, "readLinesBackwardSync").mockImplementation(() => {
        throw error;
    });

    try {
        const coverage = journalCoverage({ refsPath, tabs: [{ surfaceId: "surface-1", agent: true }] });
        expect(coverage).toEqual({ tabs: 1, recorded: null, agentTabs: 1, unrecordedAgentTabs: [] });
        expect(describeJournalCoverage(coverage)).toBe("not checked (the surface journal could not be read)");
        expect(describeJournalJoin(coverage)).toBe("not checked (the surface journal could not be read)");
        expect(journalCoverageWarning(coverage)).toBe(
            "Surface-journal coverage not checked (the journal could not be read)."
        );
        expect(journalCoverageWarning(coverage)).not.toContain("plugin list");
    } finally {
        reader.mockRestore();
    }
});
