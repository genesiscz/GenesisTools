import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { applyReplacement, computeSessionChanges } from "@genesiscz/utils/session-changes";
import { readClaudeTranscriptFolded } from "./claude-changes";
import { emptyParseState, parseClaudeTranscript, parseLines, readClaudeTranscript } from "./claude-changes-parse";
import { canonicalClaudeTranscript, canonicalClaudeTranscriptSync } from "./claude-locate";

const REPO = "/tmp/fixture-repo";

/** Seconds past a fixed instant, as the ISO text transcripts carry. */
const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, 0) + seconds * 1000).toISOString();

type Line = Record<string, unknown>;

function prompt(promptId: string, text: string, seconds: number): Line {
    return {
        type: "user",
        promptId,
        uuid: `msg-${promptId}`,
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "user", content: text },
    };
}

function use(id: string, name: string, input: Record<string, unknown>, seconds: number): Line {
    return {
        type: "assistant",
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    };
}

function result(
    promptId: string,
    id: string,
    seconds: number,
    extra: { toolUseResult?: unknown; isError?: boolean } = {}
): Line {
    return {
        type: "user",
        promptId,
        timestamp: at(seconds),
        cwd: REPO,
        message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, is_error: extra.isError === true }],
        },
        toolUseResult: extra.toolUseResult,
    };
}

function jsonl(lines: Line[]): string {
    return lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n");
}

function compute(transcript: Parameters<typeof computeSessionChanges>[0]["transcript"]) {
    return computeSessionChanges({
        sessionId: "fixture-session",
        transcript,
        home: "/home/fixture",
        tempDirs: ["/scratch-tmp"],
        repoRoot: (dir) => (dir === REPO || dir.startsWith(`${REPO}/`) ? REPO : null),
        isDirectory: () => false,
    });
}

describe("parseClaudeTranscript", () => {
    it("reads turns, file-tool before/after text, failures, harness detections and subagent calls", () => {
        const main = jsonl([
            prompt("p1", "change a", 0),
            use("t-edit", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "$& two" }, 1),
            result("p1", "t-edit", 2, {
                toolUseResult: { originalFile: "one\n", oldString: "one", newString: "$& two" },
            }),
            use("t-new", "Write", { file_path: `${REPO}/new.ts`, content: "fresh\n" }, 3),
            result("p1", "t-new", 4, { toolUseResult: { type: "create", originalFile: null, content: "fresh\n" } }),
            use("t-bad", "Edit", { file_path: `${REPO}/b.ts`, old_string: "zz", new_string: "yy" }, 5),
            result("p1", "t-bad", 6, { isError: true }),
            use("t-sh", "Bash", { command: "bun scripts/codemod.ts" }, 7),
            result("p1", "t-sh", 8, {
                toolUseResult: {
                    bashEditDiff: {
                        files: [
                            { filePath: `${REPO}/c.ts`, hunks: [{ oldStart: 3, oldLines: 1 }] },
                            { filePath: `${REPO}/d.ts`, hunks: [{ oldStart: 0, oldLines: 0 }] },
                        ],
                    },
                },
            }),
            use("t-agent", "Agent", { prompt: "help" }, 9),
            result("p1", "t-agent", 30),
            prompt("p2", "and big.ts", 40),
            {
                type: "file-history-snapshot",
                messageId: "msg-p2",
                snapshot: {
                    messageId: "msg-p2",
                    trackedFileBackups: { "big.ts": { backupFileName: "big@v2", realParentDir: REPO } },
                },
            },
            use("t-big", "Edit", { file_path: `${REPO}/big.ts`, old_string: "old", new_string: "new" }, 41),
            result("p2", "t-big", 42, { toolUseResult: { originalFile: null, oldString: "old", newString: "new" } }),
        ]);
        const subagent = jsonl([
            { type: "user", promptId: "sub-prompt", timestamp: at(10), cwd: REPO, message: { content: "task" } },
            use("t-sub", "Write", { file_path: `${REPO}/by-agent.ts`, content: "agent\n" }, 11),
            result("sub-prompt", "t-sub", 12, { toolUseResult: { type: "create", originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", {
            main,
            subagents: [{ agentId: "agent-1", content: subagent, parentToolUseId: "t-agent" }],
            readBackup: (name) => (name === "big@v2" ? "old body\n" : null),
        });
        const call = (id: string) => transcript.calls.find((item) => item.id === id);

        expect(transcript.turns.map((turn) => [turn.turnId, turn.index, turn.prompt])).toEqual([
            ["p1", 0, "change a"],
            ["p2", 1, "and big.ts"],
        ]);
        expect(call("t-edit")).toMatchObject({ turnId: "p1", before: "one\n", after: "$& two\n", isError: false });
        expect(call("t-new")).toMatchObject({ before: null, after: "fresh\n" });
        expect(call("t-bad")?.isError).toBe(true);
        expect(call("t-sh")?.harnessDetected).toEqual([
            { path: `${REPO}/c.ts`, created: false },
            { path: `${REPO}/d.ts`, created: true },
        ]);
        expect(call("t-sub")).toMatchObject({ agentId: "agent-1", turnId: "p1", before: null });
        expect(call("t-big")).toMatchObject({ turnId: "p2", before: "old body\n", after: "new body\n" });
        expect(applyReplacement("a b", "b", "$&$&", false)).toBe("a $&$&");
    });
});

function snapshotLine(messageId: string, trackedFileBackups: Record<string, unknown>): Line {
    return { type: "file-history-snapshot", messageId, snapshot: { messageId, trackedFileBackups } };
}

describe("checkpoint seeds", () => {
    it("does not seed a turn from a backup file a later entry of the same name overwrote", () => {
        // Claude reuses `name@v1` after a resume, so the file on disk holds the LATER state.
        const main = jsonl([
            prompt("p1", "first visit", 0),
            {
                type: "file-history-delta",
                snapshotMessageId: "msg-p1",
                trackingPath: `${REPO}/a.ts`,
                backup: { backupFileName: "a@v1", backupTime: at(1), realParentDir: REPO },
            },
            use("e1", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "two" }, 2),
            result("p1", "e1", 3, { toolUseResult: { originalFile: null } }),
            prompt("p2", "after a resume", 100),
            {
                type: "file-history-delta",
                snapshotMessageId: "msg-p2",
                trackingPath: `${REPO}/a.ts`,
                backup: { backupFileName: "a@v1", backupTime: at(101), realParentDir: REPO },
            },
            use("e2", "Edit", { file_path: `${REPO}/a.ts`, old_string: "two", new_string: "three" }, 102),
            result("p2", "e2", 103, { toolUseResult: { originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", { main, readBackup: () => "two\n" });
        const call = (id: string) => transcript.calls.find((item) => item.id === id);

        expect(call("e1")?.before).toBeUndefined();
        expect(call("e1")?.after).toBeUndefined();
        expect(call("e2")).toMatchObject({ before: "two\n", after: "three\n" });
    });

    it("leaves a call unknown when its edit does not apply to the seeded state", () => {
        const main = jsonl([
            prompt("p1", "edit", 0),
            snapshotLine("msg-p1", { "a.ts": { backupFileName: "a@v1", backupTime: at(0), realParentDir: REPO } }),
            use("e1", "Edit", { file_path: `${REPO}/a.ts`, old_string: "gone", new_string: "x" }, 1),
            result("p1", "e1", 2, { toolUseResult: { originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", { main, readBackup: () => "other\n" });

        expect(transcript.calls[0]?.before).toBeUndefined();
        expect(compute(transcript).files[0]).toMatchObject({ skipped: "no-before-state" });
    });
});

describe("parseLines", () => {
    it("keeps the input of a file tool only: no rule reads another tool's input again, and a fold keeps them all", () => {
        const state = emptyParseState();
        parseLines(
            jsonl([
                prompt("p1", "go", 0),
                use("t-read", "Read", { file_path: "/x/a.ts" }, 1),
                use("t-bash", "Bash", { command: "ls" }, 2),
                use("t-edit", "Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" }, 3),
            ]),
            null,
            state
        );

        expect([...state.calls.keys()]).toEqual(["t-read", "t-bash", "t-edit"]);
        expect(state.calls.get("t-bash")?.command).toBe("ls");
        expect([...state.inputs.keys()]).toEqual(["t-edit"]);
    });
});

describe("readClaudeTranscriptFolded", () => {
    it("equals a full read as the main and sub-agent files grow, with the cross-file steps applied", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-session-fold-"));
        const main = join(dir, "fold-session.jsonl");
        const agents = join(dir, "fold-session", "subagents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(
            join(agents, "agent-a1.meta.json"),
            SafeJSON.stringify({ toolUseId: "t-agent" }, { strict: true })
        );
        const agent = join(agents, "agent-a1.jsonl");
        const lines = (items: Line[]) => `${jsonl(items)}\n`;
        const same = () => {
            const folded = readClaudeTranscriptFolded(main, { minBytes: 0 });
            expect(folded).toEqual(readClaudeTranscript(main));
            return folded;
        };

        // A turn without prompt text: the sub-agent's prompt line fills it, as the full read does.
        writeFileSync(
            main,
            lines([
                prompt("p1", "", 0),
                use("t-agent", "Agent", { prompt: "help" }, 1),
                use("t-main", "Bash", { command: "ls" }, 2),
            ])
        );
        writeFileSync(agent, lines([prompt("p1", "from the agent", 3)]));
        same();

        // The sub-agent answers a call of the main file, then makes its own.
        appendFileSync(agent, lines([result("p1", "t-main", 4), use("t-sub", "Bash", { command: "pwd" }, 5)]));
        same();

        // A line no rule reads between two that are read, and text outside ASCII: the fold decodes only the lines a
        // parse reads, from the raw bytes, and must find the same lines and the same text.
        appendFileSync(main, `{"type":"attachment","note":"příliš žluťoučký kůň"}\n`);
        appendFileSync(main, lines([result("p1", "t-agent", 6), prompt("p2", "další krok 🚀", 7)]));
        const final = same();
        expect(final.calls.find((call) => call.id === "t-main")?.finishedAt).not.toBeNull();
        expect(final.turns.find((turn) => turn.turnId === "p1")?.prompt).toBe("from the agent");
        expect(final.calls.find((call) => call.id === "t-sub")?.agentId).toBe("a1");
        expect(final.turns.find((turn) => turn.turnId === "p2")?.prompt).toBe("další krok 🚀");
    });
});

describe("readChanges finds the canonical copy of a duplicated id", () => {
    const id = "11111111-2222-4333-8444-666666666666";
    const realLines = [
        prompt("p1", "change a", 0),
        use("t-edit", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "two" }, 1),
        result("p1", "t-edit", 2, { toolUseResult: { originalFile: "one\n" } }),
    ];
    /** A Claude config dir whose projects hold a title-only stub of `id` first in folder order, the conversation after. */
    function duplicated(): { home: string; root: string; real: string; stub: string } {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-changes-"));
        const root = join(home, "projects");
        const stub = join(root, "-a-moved", `${id}.jsonl`);
        const real = join(root, "-b-repo", `${id}.jsonl`);
        mkdirSync(join(root, "-a-moved"), { recursive: true });
        mkdirSync(join(root, "-b-repo"), { recursive: true });
        writeFileSync(real, `${jsonl(realLines)}\n`);
        writeFileSync(stub, `${jsonl([{ type: "custom-title", customTitle: "a long title", sessionId: id }])}\n`);
        // The stub is also the newest file, as Claude Code writes it after a cwd move.
        utimesSync(real, new Date("2026-10-30T10:00:00Z"), new Date("2026-10-30T10:00:00Z"));
        utimesSync(stub, new Date("2026-10-31T10:00:00Z"), new Date("2026-10-31T10:00:00Z"));
        return { home, root, real, stub };
    }

    it("answers the conversation, not the stub listed first, from both locator forms and by an 8-character prefix", async () => {
        const { root, real } = duplicated();
        // The case this guards: the first copy in folder order is the stub (the old lookup took it).
        expect(readdirSync(root)[0]).toBe("-a-moved");

        for (const query of [id, id.toUpperCase(), id.slice(0, 8)]) {
            expect(canonicalClaudeTranscriptSync(query, { native: [root] })).toBe(real);
            expect(await canonicalClaudeTranscript(query, { native: [root] })).toBe(real);
        }

        expect(canonicalClaudeTranscriptSync(id.slice(0, 7), { native: [root] })).toBeUndefined();
        expect(await canonicalClaudeTranscript(id, { native: [root] }, { projectFolder: "-a-moved" })).toBe(
            join(root, "-a-moved", `${id}.jsonl`)
        );
    });

    it("reads the session's changes through the Claude reader's readChanges member", async () => {
        const { home, real } = duplicated();

        await env.testing.withOverrides({ CLAUDE_CONFIG_DIR: home }, () => {
            const read = resolveHistoryProvider("claude").reader.readChanges(id);

            expect(read?.transcriptPath).toBe(real);
            expect(read?.transcript).toEqual(readClaudeTranscript(real));
            expect(read?.transcript.calls.map((call) => [call.id, call.before, call.after])).toEqual([
                ["t-edit", "one\n", "two\n"],
            ]);
        });
    });
});
