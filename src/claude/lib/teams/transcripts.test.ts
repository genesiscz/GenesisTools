import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

describe("indexTeamTranscripts in-process sidechains", () => {
    const leadId = "3ef3c468-e0f1-4959-8f16-e2d3ce7c4feb";

    function writeSidechain(dir: string, agentName: string, lastText: string): string {
        const sub = join(dir, leadId, "subagents");
        mkdirSync(sub, { recursive: true });
        const stem = `agent-a${agentName}-629d28c8906398e7`;
        writeFileSync(
            join(sub, `${stem}.meta.json`),
            SafeJSON.stringify({
                name: agentName,
                teamName: TEAM,
                taskKind: "in_process_teammate",
            })
        );

        const lines = [
            {
                type: "user",
                sessionId: leadId,
                timestamp: "2026-08-20T16:50:36.000Z",
                message: { content: `<teammate-message teammate_id="team-lead">Do the thing</teammate-message>` },
            },
            {
                type: "assistant",
                sessionId: leadId,
                timestamp: "2026-08-20T17:12:25.000Z",
                message: { content: [{ type: "text", text: lastText }] },
            },
        ];
        const path = join(sub, `${stem}.jsonl`);
        writeFileSync(path, `${lines.map((l) => SafeJSON.stringify(l)).join("\n")}\n`);
        return path;
    }

    test("meta.teamName owns the sidechain — transcript text cannot claim it for another team", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-sidechain-"));
        const sub = join(dir, leadId, "subagents");
        mkdirSync(sub, { recursive: true });
        const stem = "agent-aborrowed-629d28c8906398e7";
        writeFileSync(
            join(sub, `${stem}.meta.json`),
            SafeJSON.stringify({ name: "borrowed", teamName: "team-alpha", taskKind: "in_process_teammate" })
        );
        // The body mentions the other team, which used to be enough to index
        // this agent under it and later resume the wrong lead session.
        writeFileSync(
            join(sub, `${stem}.jsonl`),
            `${SafeJSON.stringify({
                type: "assistant",
                sessionId: leadId,
                timestamp: "2026-08-20T17:12:25.000Z",
                message: { content: [{ type: "text", text: `working alongside ${TEAM} on the same repo` }] },
            })}\n`
        );

        expect(indexTeamTranscripts(dir, TEAM).get("borrowed")).toBeUndefined();
        expect(indexTeamTranscripts(dir, "team-alpha").get("borrowed")).toBeDefined();
    });

    test("an ordinary subagent sidecar is not indexed as a teammate", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-sidechain-"));
        const sub = join(dir, leadId, "subagents");
        mkdirSync(sub, { recursive: true });
        const stem = "agent-aexplore-629d28c8906398e7";
        writeFileSync(
            join(sub, `${stem}.meta.json`),
            SafeJSON.stringify({ name: "explore", teamName: TEAM, taskKind: "task" })
        );
        writeFileSync(
            join(sub, `${stem}.jsonl`),
            `${SafeJSON.stringify({
                type: "assistant",
                sessionId: leadId,
                timestamp: "2026-08-20T17:12:25.000Z",
                message: { content: [{ type: "text", text: "searched the repo" }] },
            })}\n`
        );

        expect(indexTeamTranscripts(dir, TEAM).get("explore")).toBeUndefined();
    });

    test("indexes <lead>/subagents/agent-*.jsonl via meta.json even without agentName fields", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-sidechain-"));
        writeSidechain(dir, "pageobjects-fable", "While the retry downloads, verifying the MePAS locators.");

        const found = indexTeamTranscripts(dir, TEAM).get("pageobjects-fable");
        expect(found).toBeDefined();
        expect(found?.sidechain).toBe(true);
        expect(found?.sessionId).toBe(leadId);
        expect(found?.hasLeadAssignment).toBe(true);
        expect(found?.lastMessage?.text).toContain("MePAS locators");
        expect(found?.path).toContain(`${leadId}/subagents/`);
    });

    test("a newer sidechain wins over an older standalone jsonl of the same agent", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-sidechain-"));
        const standaloneId = "b9799f97-ead9-4d25-ada1-51635a3e924f";
        writeTranscript(dir, standaloneId, "pageobjects-fable");
        const side = writeSidechain(dir, "pageobjects-fable", "MePAS selectors confirmed correct.");
        expect(side).toContain("subagents");

        // Back-to-back writes can land on the same mtime, and the standalone
        // file is indexed first, so a tie would keep it and fail this test for
        // a reason that has nothing to do with the rule under test.
        const hour = new Date(Date.now() - 3_600_000);
        utimesSync(join(dir, `${standaloneId}.jsonl`), hour, hour);

        const found = indexTeamTranscripts(dir, TEAM).get("pageobjects-fable");
        expect(found?.sidechain).toBe(true);
        expect(found?.sessionId).toBe(leadId);
        expect(found?.lastMessage?.text).toContain("MePAS selectors");
    });

    test("does not treat the filename agent-a… as the --resume id", () => {
        const dir = mkdtempSync(join(tmpdir(), "teams-sidechain-"));
        writeSidechain(dir, "pageobjects-fable", "on it");

        const found = indexTeamTranscripts(dir, TEAM).get("pageobjects-fable");
        expect(found?.sessionId).toBe(leadId);
        expect(found?.sessionId.startsWith("agent-")).toBe(false);
    });
});
