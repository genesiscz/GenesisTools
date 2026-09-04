import { describe, expect, test } from "bun:test";
import { matchRunningTurnLine, runningTurnPids } from "./ps";

const UUID = "9f1c2b34-5d6e-47a8-9012-3456789abcde";

describe("matchRunningTurnLine", () => {
    test("matches a grok worker turn", () => {
        const line = `  4211 /Users/x/.grok/bin/grok -p --session-id ${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /grok/)?.pid).toBe(4211);
    });

    test("matches a later turn resumed by uuid", () => {
        const line = `  4212 /Users/x/.grok/bin/grok -p --resume ${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /grok/)?.pid).toBe(4212);
    });

    test("matches a claude worker turn", () => {
        const line = `  99 /Users/x/.bun/bin/claude -p --output-format stream-json --session-id ${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /claude/)?.pid).toBe(99);
    });

    test("matches a codex worker turn", () => {
        const line = `  100 /opt/homebrew/bin/codex resume ${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /codex/)?.pid).toBe(100);
    });

    test("matches the --flag=<uuid> spelling", () => {
        const line = `  101 /opt/homebrew/bin/codex --session=${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /codex/)?.pid).toBe(101);
    });

    test("ignores a tail that merely reads the session transcript", () => {
        // The reported kill: the path carries both "grok" and the uuid, so the
        // old whole-line filter returned this pid and the caller SIGTERMed it.
        const line = `  777 tail -f /Users/x/.grok/sessions/repo/${UUID}/chat_history.jsonl`;

        expect(matchRunningTurnLine(line, UUID, /grok/)).toBeUndefined();
    });

    test("ignores an editor holding the transcript open", () => {
        const line = `  778 /usr/bin/vim /Users/x/.claude/projects/repo/${UUID}.jsonl`;

        expect(matchRunningTurnLine(line, UUID, /claude/)).toBeUndefined();
    });

    test("ignores the agent binary running a different session", () => {
        const line = "  779 /Users/x/.grok/bin/grok -p --session-id 11111111-2222-3333-4444-555555555555";

        expect(matchRunningTurnLine(line, UUID, /grok/)).toBeUndefined();
    });

    test("ignores a neighbouring binary that only shares the name prefix", () => {
        const line = `  780 /Users/x/.bun/bin/bun /Users/x/.grok/grok-proxy.ts up ${UUID}`;

        expect(matchRunningTurnLine(line, UUID, /grok/)).toBeUndefined();
    });

    test("ignores a blank line", () => {
        expect(matchRunningTurnLine("   ", UUID, /grok/)).toBeUndefined();
    });
});

describe("runningTurnPids", () => {
    test("refuses a marker too short to identify a session", async () => {
        expect(await runningTurnPids("abc", /grok/)).toEqual([]);
    });
});
