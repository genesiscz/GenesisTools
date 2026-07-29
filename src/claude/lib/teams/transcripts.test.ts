import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { indexTeamTranscripts } from "./transcripts";

const TEAM = "session-55a1a95d";

/**
 * One transcript per agent, in the shape the indexer reads: a lead assignment
 * wrapped in `<teammate-message>` followed by the agent's reply. Names go through
 * SafeJSON.stringify so the file holds the real JSON encoding of each name — that
 * encoding is the thing under test.
 */
function writeTranscript(dir: string, sessionId: string, agentName: string): void {
    const lines = [
        {
            type: "user",
            agentName,
            teamName: TEAM,
            timestamp: "2026-07-29T04:00:00.000Z",
            message: { content: `<teammate-message teammate_id="team-lead">Do the thing</teammate-message>` },
        },
        {
            type: "assistant",
            agentName,
            teamName: TEAM,
            timestamp: "2026-07-29T04:01:00.000Z",
            message: { content: [{ type: "text", text: "on it" }] },
        },
    ];

    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.map((l) => SafeJSON.stringify(l)).join("\n")}\n`);
}

// Agent names reach the indexer as JSON string literals inside the transcript, and
// used to be pulled out with a raw regex capture that was then interpolated into
// another regex. Both halves broke on names that are not plain identifiers.
describe("indexTeamTranscripts with awkward agent names", () => {
    const cases: Array<[string, string, string]> = [
        ["regex punctuation", "regex-punct", "agent(1)+x.y"],
        ["unbalanced bracket", "unbalanced", "a[b"],
        ["regex quantifier", "quantifier", "a*b?c"],
        ["json-escaped backslash", "backslash", "a\\b"],
        ["json-escaped quote", "quote", 'a"b'],
        ["plain", "plain", "bm-research-product"],
    ];

    for (const [label, sessionId, agentName] of cases) {
        test(`${label}: indexed under the decoded name`, () => {
            const dir = mkdtempSync(join(tmpdir(), "teams-transcripts-"));
            writeTranscript(dir, sessionId, agentName);

            const index = indexTeamTranscripts(dir, TEAM);
            const found = index.get(agentName);

            expect(found).toBeDefined();
            expect(found?.sessionId).toBe(sessionId);
            expect(found?.hasLeadAssignment).toBe(true);
        });
    }

    test("an unbalanced-bracket name does not throw and does not hide its neighbours", () => {
        // The old code built `new RegExp(...)` from the name: `a[b` threw and took
        // the whole index pass down, losing every other agent in the project.
        const dir = mkdtempSync(join(tmpdir(), "teams-transcripts-"));
        writeTranscript(dir, "hostile", "a[b");
        writeTranscript(dir, "innocent", "plain-mate");

        const index = indexTeamTranscripts(dir, TEAM);

        expect([...index.keys()].sort()).toEqual(["a[b", "plain-mate"]);
    });

    test("the lead's own transcript is never indexed as a teammate", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-transcripts-"));
        writeTranscript(dir, "lead", "team-lead");

        expect(indexTeamTranscripts(dir, TEAM).size).toBe(0);
    });

    test("a transcript belonging to another team is not picked up", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-transcripts-"));
        writeTranscript(dir, "elsewhere", "someone");

        expect(indexTeamTranscripts(dir, "session-different").size).toBe(0);
    });
});
