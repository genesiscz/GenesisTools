import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectFolder, modelInTranscriptLines } from "./caller";
import { appendFailure, readFailures, type ToolFailure } from "./record";
import { classifyExit, commandPathFromArgv, jsonErrorMessage, messageOfTail, redactArgv } from "./watch";

describe("redactArgv", () => {
    it("masks the value of a secret-named flag in both spellings and keeps the rest", () => {
        expect(redactArgv(["login", "--api-key", "abc123", "--token=xyz", "--name", "work"])).toEqual([
            "login",
            "--api-key",
            "[redacted]",
            "--token=[redacted]",
            "--name",
            "work",
        ]);
    });

    it("masks a secret-shaped argument without a flag", () => {
        expect(redactArgv(["set", "sk-ant-abcdefghijklmnopqrstuvwxyz0123"])).toEqual(["set", "[redacted]"]);
    });
});

describe("classifyExit", () => {
    const none = { noted: null, stderrTail: "" };

    it("is no failure on exit 0 and an interrupt on 130 or 143", () => {
        expect(classifyExit({ exitCode: 0, ...none })).toBeNull();
        expect(classifyExit({ exitCode: 130, ...none })).toBe("interrupt");
        expect(classifyExit({ exitCode: 143, ...none })).toBe("interrupt");
    });

    it("names commander's refusal and a bare help as usage, anything else as exit", () => {
        expect(classifyExit({ exitCode: 1, noted: null, stderrTail: "error: unknown option '--x'\n" })).toBe("usage");
        expect(classifyExit({ exitCode: 1, noted: null, stderrTail: "Usage: tools ts [options]\n" })).toBe("usage");
        expect(classifyExit({ exitCode: 2, noted: null, stderrTail: "could not find it\n" })).toBe("exit");
    });

    it("a fatal crash wins even when the exit event reports 0 (Bun after an unhandled rejection)", () => {
        expect(
            classifyExit({ exitCode: 0, noted: { kind: "crash", error: new Error("x"), fatal: true }, stderrTail: "" })
        ).toBe("crash");
        expect(
            classifyExit({ exitCode: 1, noted: { kind: "error", error: new Error("x"), fatal: true }, stderrTail: "" })
        ).toBe("error");
    });
});

describe("messageOfTail", () => {
    it("picks commander's error line over the help printed after it", () => {
        expect(
            messageOfTail("error: missing required argument 'entry'\n\nUsage: tools ts imports analyze <entry>\n")
        ).toBe("error: missing required argument 'entry'");
    });

    it("falls back to the last non-empty line", () => {
        expect(messageOfTail("working…\nno such worktree: feat/x\n\n")).toBe("no such worktree: feat/x");
        expect(messageOfTail("")).toBeNull();
    });
});

describe("jsonErrorMessage", () => {
    it("reads the last JSON error line in each common shape and ignores results", () => {
        expect(
            jsonErrorMessage(
                '{"type":"progress"}\n{"type":"error","command":"update","message":"index is not built"}\n'
            )
        ).toBe("index is not built");
        expect(jsonErrorMessage('{"error":{"message":"rate limited"}}')).toBe("rate limited");
        expect(jsonErrorMessage('{"error":"busy"}')).toBe("busy");
        expect(jsonErrorMessage('{"rows":[]}\nplain text')).toBeNull();
    });
});

describe("commandPathFromArgv", () => {
    interface Node {
        name(): string;
        aliases(): string[];
        commands: Node[];
    }
    const node = (name: string, commands: Node[] = [], aliases: string[] = []): Node => ({
        name: () => name,
        aliases: () => aliases,
        commands,
    });
    const program = node("ai", [node("usage", [node("sessions")], ["u"])]);

    it("follows the leading words through subcommands and aliases, and stops at an option", () => {
        expect(commandPathFromArgv(program, ["u", "sessions", "--bad"])).toBe("ai usage sessions");
        expect(commandPathFromArgv(program, ["usage", "--hours", "sessions"])).toBe("ai usage");
        expect(commandPathFromArgv(program, ["nope"])).toBe("ai");
    });
});

describe("modelInTranscriptLines", () => {
    it("reads the newest model of a Claude or a Codex transcript and skips synthetic turns", () => {
        const claude = [
            '{"type":"assistant","message":{"model":"claude-sonnet-5-5"}}',
            '{"type":"user","message":{"content":"x"}}',
            '{"type":"assistant","message":{"model":"<synthetic>"}}',
        ];
        expect(modelInTranscriptLines(claude)).toBe("claude-sonnet-5-5");
        expect(modelInTranscriptLines(['{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}'])).toBe(
            "gpt-6.1-sol"
        );
        expect(modelInTranscriptLines(['{"type":"user"}'])).toBeNull();
    });

    it("names the project folder the way Claude does", () => {
        expect(claudeProjectFolder("/Users/me/Projects/My App.v2")).toBe("-Users-me-Projects-My-App-v2");
    });
});

describe("failure records", () => {
    it("reads back what was appended, by day, and skips a cut line", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-failures-"));
        const failure: ToolFailure = {
            v: 1,
            id: "a-1",
            at: new Date(2026, 9, 22, 12).toISOString(),
            kind: "usage",
            tool: "ts",
            command: "ts skeleton",
            argv: ["skeleton", "--bogus"],
            exitCode: 1,
            message: "error: unknown option '--bogus'",
            errorName: null,
            stack: null,
            stderrTail: null,
            fatal: true,
            durationMs: 120,
            pid: 1,
            ppid: 0,
            cwd: "/repo",
            traceId: null,
            toolsRoot: "/repo",
            caller: null,
        };
        appendFailure(failure, dir);
        await Bun.write(
            join(dir, "2026-10-22-failures.jsonl"),
            `${await Bun.file(join(dir, "2026-10-22-failures.jsonl")).text()}{"v":1,"to`
        );

        expect([...readFailures({ fromDay: "2026-10-22", toDay: "2026-10-22", dir })]).toEqual([failure]);
        expect([...readFailures({ fromDay: "2026-10-23", toDay: "2026-10-24", dir })]).toEqual([]);
    });
});
