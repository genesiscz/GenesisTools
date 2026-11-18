import { expect, it } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { auditClaudeFacts } from "./claude-changes-audit";
import { advanceClaudeFacts, sessionFacts } from "./claude-changes-facts";
import { claudeFixture, claudeFixtureNames, createFile, jsonl, prompt } from "./fixtures/changes/claude-sessions";

for (const name of claudeFixtureNames) {
    it(`agrees with the full parser's change facts for ${name}`, () => {
        const { transcript } = claudeFixture(name);
        if (!transcript) {
            throw new Error("missing Claude fixture");
        }
        expect(auditClaudeFacts(transcript)).toEqual({
            ledger: true,
            positions: true,
            checkpoints: true,
            writers: true,
            cwds: true,
            editedDirs: true,
            shellCalls: true,
            calls: true,
        });
    });
}

it("indexes direct and indirect heredoc writers, then resumes or rebuilds on a rewrite", () => {
    const { transcript } = claudeFixture("heredoc");
    if (!transcript) {
        throw new Error("missing Claude fixture");
    }
    const original = advanceClaudeFacts(transcript, true);
    const facts = sessionFacts(new Map([[transcript, original]]));
    expect(facts.writersOf("/work/acme/gen.sh").map((w) => w.callId)).toContain("generate");
    expect(facts.writersOf("/any/target").map((w) => w.callId)).toEqual(
        expect.arrayContaining(["run-gen", "run-written"])
    );
    appendFileSync(
        transcript,
        `${jsonl([prompt("p9", "", 90), ...createFile("p9", "last", "/work/acme/last", 91)])}\n`
    );
    const grown = advanceClaudeFacts(transcript, true, original);
    expect(grown.state.ledger.size).toBe(9);
    writeFileSync(transcript, `${jsonl([prompt("replacement", "", 100)])}\n`);
    expect([...advanceClaudeFacts(transcript, true, grown).state.ledger.keys()]).toEqual(["replacement"]);
});

it("resumes an unfinished line and defers a valid record missing only its newline", () => {
    const { transcript } = claudeFixture("basic");
    if (!transcript) {
        throw new Error("missing Claude fixture");
    }
    const old = advanceClaudeFacts(transcript, true);
    const record = jsonl([prompt("after", "příliš", 95)]);
    const split = record.length - 3;
    appendFileSync(transcript, record.slice(0, split));
    const partial = advanceClaudeFacts(transcript, true, old);
    expect(partial.state.ledger.has("after")).toBe(false);
    appendFileSync(transcript, record.slice(split));
    expect(() => advanceClaudeFacts(transcript, true, partial)).toThrow("without its newline");
    appendFileSync(transcript, "\n");
    expect(advanceClaudeFacts(transcript, true, partial).state.ledger.has("after")).toBe(true);
});
