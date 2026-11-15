import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { whoIsCalling } from "@genesiscz/utils/agent/identity";
import { deadlineRecording, Executor } from "@genesiscz/utils/cli/executor";
import { compressFile } from "@genesiscz/utils/compress/file";
import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { recordMcpCall, recordMcpTransport } from "@genesiscz/utils/mcp/record-call";
import { Command } from "commander";
import { claudeProjectFolder, failureCaller, failureCallerOf, transcriptOf } from "./caller";
import { captureFailureContext, enrichFailureContext, readFailureContext } from "./context";
import { deadlineCaller, deadlineWrite } from "./deadline";
import { recordHandledFailure } from "./handled";
import { recordSignalEnd, signalEnd, signalOfStatus, WITHHELD_ARGV } from "./launcher";
import { appendFailure, failureDays, failureLogPath, readFailures, type ToolFailure } from "./record";
import { RUN_ID_ENV } from "./run-id";
import { signalExitStatus } from "./signal-status";
import {
    classifyExit,
    commandPathFromArgv,
    jsonErrorMessage,
    messageOfTail,
    redactArgv,
    redactRunText,
    secretsFromArgv,
    WITHHELD_TEXT,
} from "./watch";

describe("handled call failures", () => {
    it("persists the failure before the live process exits, using the existing v1 reader", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-handled-failure-"));
        const day = formatLocalDate(new Date());
        const written = recordHandledFailure({
            tool: "fixture",
            call: "read",
            error: new Error("fixture failed"),
            dir,
            caller: null,
        });
        const reopened = [...readFailures({ fromDay: day, toDay: day, dir })];
        expect(reopened).toHaveLength(1);
        const persisted = reopened[0];
        if (!persisted) {
            throw new Error("the failure event must be persisted");
        }

        const context = readFailureContext({ failure: persisted, dir });
        expect(context.failureAt).toBe(persisted.at);
        expect(context.runtime.state).toBe("captured");
        expect(context.preparedAt).not.toBeNull();
        expect(context.markdown).toContain("fixture failed");
        enrichFailureContext({
            failure: persisted,
            dir,
            triage: { capturedAt: persisted.at, markdown: "Full fixture triage" },
        });
        const enriched = readFailureContext({ failure: persisted, dir });
        expect(enriched.runtime).toEqual(context.runtime);
        expect(enriched.triage?.markdown).toBe("Full fixture triage");
        expect(enriched.markdown).toContain("Full fixture triage");
        const legacy = readFailureContext({ failure: { ...persisted, id: "legacy-no-context" }, dir });
        expect(legacy.runtime.state).toBe("unavailable");
        expect(legacy.preparedAt).toBeNull();
        expect(legacy.markdown).toContain("fixture failed");
        expect(reopened[0]).toMatchObject({
            id: written?.id,
            v: 1,
            command: "fixture",
            argv: [],
            operation: { transport: "mcp", server: "fixture", name: "read" },
            fatal: false,
            exitCode: null,
            message: "fixture failed",
            caller: null,
        });
    });

    it("masks a live server's declared short secret alias in handled error text", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-handled-secret-"));
        const script = [
            `import { watchToolRun } from "${join(import.meta.dir, "watch.ts")}";`,
            `import { recordHandledFailure } from "${join(import.meta.dir, "handled.ts")}";`,
            `watchToolRun({ tool: "fixture", argv: ["mcp", "-t", "fixture-password"], secrets: () => ({ flags: ["-t"], indexes: [] }), caller: () => null });`,
            `recordHandledFailure({ tool: "fixture", call: "read", error: new Error("refused fixture-password"), dir: ${SafeJSON.stringify(dir)}, caller: null });`,
        ].join("\n");
        const child = Bun.spawnSync([process.execPath, "-e", script], {
            cwd: process.cwd(),
            env: process.env,
            stderr: "pipe",
            stdout: "pipe",
        });
        expect(child.exitCode).toBe(0);
        const day = formatLocalDate(new Date());
        const records = [...readFailures({ fromDay: day, toDay: day, dir })];
        expect(records).toHaveLength(1);
        expect(records[0]?.argv).toEqual(["mcp", "-t", "[redacted]"]);
        expect(records[0]?.message).toContain("[redacted]");
        expect(SafeJSON.stringify(records)).not.toContain("fixture-password");
    });

    it("records returned errors and exceptions, preserving the HTTP/embedded protocol result", async () => {
        const calls: Parameters<typeof recordHandledFailure>[0][] = [];
        const record: typeof recordHandledFailure = (options) => {
            calls.push(options);
            return null;
        };
        const answer = { isError: true, content: [{ type: "text" as const, text: "fixture failed" }] };
        expect(await recordMcpCall({ server: "fixture", name: "read", run: async () => answer, record })).toBe(answer);
        const error = new Error("thrown failure");
        await expect(
            recordMcpCall({
                server: "fixture",
                name: "write",
                run: async () => {
                    throw error;
                },
                record,
            })
        ).rejects.toBe(error);
        expect(calls.map((call) => call.call)).toEqual(["read", "write"]);
        expect(calls[1]?.error).toBe(error);
        await recordMcpCall({ server: "fixture", name: "list", run: async () => ({ content: [] }), record });
        expect(calls).toHaveLength(2);
    });

    it("covers custom stdio handlers without retaining arguments or changing messages", async () => {
        const failures: Parameters<typeof recordHandledFailure>[0][] = [];
        const record: typeof recordHandledFailure = (options) => {
            failures.push(options);
            return null;
        };
        const received: unknown[] = [];
        const sent: unknown[] = [];
        const underlying = {
            onmessage: (_message: unknown) => {},
            async send(message: unknown) {
                sent.push(message);
            },
            async close() {},
        };
        const transport = recordMcpTransport({ transport: underlying, server: "fixture", record });
        transport.onmessage = (message) => {
            received.push(message);
        };
        const request = {
            id: 1,
            method: "tools/call",
            params: { name: "read", arguments: { privateInput: "never persist this" } },
        };
        underlying.onmessage(request);
        const response = { id: 1, result: { isError: true, content: [{ type: "text", text: "fixture error" }] } };
        await transport.send(response);
        expect(received[0]).toBe(request);
        expect(sent[0]).toBe(response);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.call).toBe("read");
        expect(SafeJSON.stringify(failures)).not.toContain("never persist this");
        underlying.onmessage({ id: "1", method: "tools/call", params: { name: "unknown" } });
        const protocolError = { id: "1", error: { code: -32601, message: "unknown tool" } };
        await transport.send(protocolError);
        expect(sent[1]).toBe(protocolError);
        expect(failures).toHaveLength(2);
    });

    it("a server-to-client request with the id of a running call does not end that call", async () => {
        const failures: unknown[] = [];
        const underlying = {
            onmessage: (_message: unknown) => undefined,
            async send(_message: unknown) {},
            async close() {},
        };
        const transport = recordMcpTransport({
            transport: underlying,
            server: "fixture",
            record: (failure) => {
                failures.push(failure);
                return undefined as never;
            },
        });
        transport.onmessage = () => undefined;
        underlying.onmessage({ id: 7, method: "tools/call", params: { name: "read" } });
        await transport.send({ id: 7, method: "ping" });
        await transport.send({ id: 7, result: { isError: true, content: [{ type: "text", text: "fixture error" }] } });
        expect(failures).toHaveLength(1);
    });
});

describe("full triage workers", () => {
    it("starts one worker per minute however many failures arrive, and each failure keeps its own snapshot", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-triage-window-"));
        const spawned: string[][] = [];
        const failure = (id: string): ToolFailure => ({
            v: 1,
            id,
            at: new Date().toISOString(),
            kind: "error",
            tool: "fixture",
            command: "read",
            argv: [],
            exitCode: 1,
            message: "fixture failed",
            errorName: null,
            stack: null,
            stderrTail: null,
            fatal: false,
            durationMs: 1,
            pid: 1,
            ppid: 1,
            cwd: dir,
            traceId: null,
            toolsRoot: dir,
            caller: null,
        });
        const capture = (id: string, now: number) =>
            captureFailureContext({
                failure: failure(id),
                dir,
                fullTriage: true,
                now,
                spawn: (argv) => {
                    spawned.push(argv);
                    return undefined as never;
                },
            });

        capture("one", 1_000_000);
        capture("two", 1_000_500);
        capture("three", 1_059_000);
        expect(spawned.map((argv) => argv[3])).toEqual(["one"]);
        capture("four", 1_061_000);
        expect(spawned.map((argv) => argv[3])).toEqual(["one", "four"]);
        expect(readFailureContext({ failure: failure("two"), dir }).failureId).toBe("two");
    });
});

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

describe("secret option aliases", () => {
    const program = new Command("wakeup").option("-v, --verbose", "verbose").option("--log <file>", "log file");
    program
        .command("daemon")
        .command("register")
        .option("-t, --token <token>", "shared secret")
        .option("-p, --port <port>", "port");
    const args = ["daemon", "register", "-t", "fixture-password", "--port", "0"];
    const secrets = secretsFromArgv(program, args);
    const redacted = (argv: string[]) => redactArgv(argv, secretsFromArgv(program, argv));

    it("names the short and long flag of a secret-named option on the command that ran, and nothing else", () => {
        expect(secrets.flags).toEqual(["-t", "--token"]);
        expect(secretsFromArgv(program, ["daemon"]).flags).toEqual([]);
    });

    it("masks the value after a declared short alias, attached or separate", () => {
        expect(redactArgv(args, secrets)).toEqual(["daemon", "register", "-t", "[redacted]", "--port", "0"]);
        expect(redacted(["daemon", "register", "-tfixture-password"])).toEqual(["daemon", "register", "-t[redacted]"]);
    });

    it("reaches the subcommand past a global option and its value before it", () => {
        expect(redacted(["-v", "daemon", "register", "-t", "fixture-password", "--port", "0"])).toEqual([
            "-v",
            "daemon",
            "register",
            "-t",
            "[redacted]",
            "--port",
            "0",
        ]);
        expect(redacted(["--log", "out.txt", "daemon", "-v", "register", "-t", "fixture-password"])).toEqual([
            "--log",
            "out.txt",
            "daemon",
            "-v",
            "register",
            "-t",
            "[redacted]",
        ]);
    });

    it("masks a declared secret value that starts with a dash, since commander takes it as the value", () => {
        const dashed = ["daemon", "register", "--token", "-fixture-password", "--port", "0"];
        expect(redacted(dashed)).toEqual(["daemon", "register", "--token", "[redacted]", "--port", "0"]);
        expect(redactRunText("error: bad token -fixture-password", dashed, secretsFromArgv(program, dashed))).toBe(
            "error: bad token [redacted]"
        );
    });

    it("masks the value of a secret-named argument and keeps the others", () => {
        const ai = new Command("ai");
        ai.command("config").command("secret").command("set").argument("<path>").argument("[secret]");
        const argv = ["config", "secret", "set", "ai/work/password", "correct-horse-battery-staple"];
        expect(redactArgv(argv, secretsFromArgv(ai, argv))).toEqual([
            "config",
            "secret",
            "set",
            "ai/work/password",
            "[redacted]",
        ]);
    });

    it("masks a secret value attached inside a group of short flags, in argv and where text echoes it", () => {
        const grouped = ["daemon", "register", "-vtfixture-password", "--port", "0"];
        const groupedSecrets = secretsFromArgv(program, grouped);
        expect(redactArgv(grouped, groupedSecrets)).toEqual(["daemon", "register", "-vt[redacted]", "--port", "0"]);
        expect(redactRunText("error: port 0 is invalid for fixture-password", grouped, groupedSecrets)).toBe(
            "error: port 0 is invalid for [redacted]"
        );
    });

    it("masks every operand past a flag no command declares when a command there takes a secret", () => {
        const ai = new Command("ai");
        ai.command("config").command("secret").command("set").argument("<path>").argument("[secret]");
        ai.command("usage").argument("[day]");
        const refused = ["config", "secret", "set", "--bogus", "ai/work/password", "correct-horse-battery-staple"];
        const refusedSecrets = secretsFromArgv(ai, refused);
        expect(redactArgv(refused, refusedSecrets)).toEqual([
            "config",
            "secret",
            "set",
            "--bogus",
            "[redacted]",
            "[redacted]",
        ]);
        expect(redactRunText("error: rejected correct-horse-battery-staple", refused, refusedSecrets)).toBe(
            "error: rejected [redacted]"
        );

        const early = ["--bogus", "config", "secret", "set", "ai/work/password", "correct-horse-battery-staple"];
        expect(redactArgv(early, secretsFromArgv(ai, early)).at(-1)).toBe("[redacted]");
        expect(redacted(["--bogus", "daemon", "register", "-tfixture-password"])).toEqual([
            "--bogus",
            "[redacted]",
            "[redacted]",
            "-t[redacted]",
        ]);

        const plain = ["usage", "--bogus", "2026-10-22"];
        expect(redactArgv(plain, secretsFromArgv(ai, plain))).toEqual(plain);
    });

    it("withholds a text that echoes a declared secret too short to replace, and keeps one that does not", () => {
        const short = ["daemon", "register", "--token", "abc"];
        const shortSecrets = secretsFromArgv(program, short);
        expect(redactArgv(short, shortSecrets)).toEqual(["daemon", "register", "--token", "[redacted]"]);
        expect(redactRunText("authentication rejected abc", short, shortSecrets)).toBe(WITHHELD_TEXT);
        expect(redactRunText("authentication rejected", short, shortSecrets)).toBe("authentication rejected");
    });

    it("masks the same values and any --secret=value where a message or stderr echoes them", () => {
        expect(redactRunText("error: bad value fixture-password for -t", args, secrets)).toBe(
            "error: bad value [redacted] for -t"
        );
        expect(redactRunText("error: unknown option '--token=fixture-password'", [])).toBe(
            "error: unknown option '--token=[redacted]'"
        );
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

    it("an exit code the tool names as an outcome is no failure, unless the run crashed or threw", () => {
        // `tools rm` exits 3 when it opened a request for the person: 23 such runs read as failures in two days
        // (2026-11-13 and 11-14).
        const outcome = { outcomeExitCodes: [3] };
        expect(classifyExit({ exitCode: 3, ...none, ...outcome })).toBeNull();
        expect(classifyExit({ exitCode: 1, ...none, ...outcome })).toBe("exit");
        expect(classifyExit({ exitCode: 3, ...none })).toBe("exit");
        expect(
            classifyExit({
                exitCode: 3,
                noted: { kind: "error", error: new Error("x"), fatal: true },
                stderrTail: "",
                ...outcome,
            })
        ).toBe("error");
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

    it("prefers clack's error line over the hints printed after it", () => {
        expect(
            messageOfTail(
                "│\n■  pattern matches 2 tabs. Refusing to guess.\n│\n●  Narrow it:\n│\n●  tools x --match /a$/\n"
            )
        ).toBe("pattern matches 2 tabs. Refusing to guess.");
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
        options: [];
    }
    const node = (name: string, commands: Node[] = [], aliases: string[] = []): Node => ({
        name: () => name,
        aliases: () => aliases,
        commands,
        options: [],
    });
    const program = node("ai", [node("usage", [node("sessions")], ["u"])]);

    it("follows the leading words through subcommands and aliases, and stops at an option", () => {
        expect(commandPathFromArgv(program, ["u", "sessions", "--bad"])).toBe("ai usage sessions");
        expect(commandPathFromArgv(program, ["usage", "--hours", "sessions"])).toBe("ai usage");
        expect(commandPathFromArgv(program, ["nope"])).toBe("ai");
    });
});

describe("the calling session", () => {
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

    it("reads a day the daily pass compressed, and a day once while its plain file and .zst both exist", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-failures-zst-"));
        const failureOn = (id: string, date: number, runId: string): ToolFailure => ({
            v: 1,
            id,
            at: new Date(2026, 9, date, 12).toISOString(),
            kind: "interrupt",
            tool: "fixture",
            command: "fixture run",
            argv: ["run"],
            exitCode: 130,
            message: null,
            errorName: null,
            stack: null,
            stderrTail: null,
            fatal: true,
            durationMs: 10,
            pid: 2,
            ppid: 1,
            cwd: "/repo",
            traceId: null,
            toolsRoot: "/repo",
            caller: null,
            runId,
        });
        const written = [failureOn("z-20", 20, "run-20"), failureOn("z-21", 21, "run-21"), failureOn("z-22", 22, "")];

        for (const failure of written) {
            appendFailure(failure, dir);
        }

        await compressFile({ source: failureLogPath("2026-10-20", dir) });
        unlinkSync(failureLogPath("2026-10-20", dir));
        await compressFile({ source: failureLogPath("2026-10-21", dir) });

        expect(failureDays(dir)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
        expect([...readFailures({ fromDay: "2026-10-20", toDay: "2026-10-22", dir })]).toEqual(written);
        const end = recordSignalEnd({
            tool: "fixture",
            runId: "run-20",
            startedAt: new Date(2026, 9, 20, 11),
            signal: "SIGTERM",
            status: null,
            viaLauncher: false,
            childPid: 2,
            toolsRoot: "/repo",
            caller: () => null,
            now: new Date(2026, 9, 22, 13),
            dir,
        });
        expect(end).toBeNull();
    });
});

/**
 * The zone this test process runs in. `bun test` runs in UTC while a child spawned from it runs in the Mac's zone, so
 * between local and UTC midnight the child's day file and the day this test reads differ (red at 2026-10-31 00:37
 * local). The children get the test's zone.
 */
const TEST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("a crash another uncaughtException listener takes", () => {
    function crashWith(handler: string): Array<[string, boolean, number | null, string | null]> {
        const home = mkdtempSync(join(tmpdir(), "gt-failures-crash-"));
        const script = [
            `import { watchToolRun } from "${join(import.meta.dir, "watch.ts")}";`,
            `watchToolRun({ tool: "fixture", argv: ["run"], caller: () => null });`,
            `process.on("uncaughtException", () => { ${handler} });`,
            `throw new Error("fixture crash");`,
        ].join("\n");
        const fromDay = formatLocalDate(new Date());
        Bun.spawnSync([process.execPath, "-e", script], {
            env: { ...process.env, GENESIS_TOOLS_HOME: home, TZ: TEST_ZONE },
            stdout: "ignore",
            stderr: "ignore",
        });
        const records = readFailures({
            fromDay,
            toDay: formatLocalDate(new Date()),
            dir: join(home, ".genesis-tools", "logs"),
        });
        return [...records].map((record) => [record.kind, record.fatal, record.exitCode, record.message]);
    }

    it("is the fatal cause of the exit when that listener ends the process", () => {
        expect(crashWith("process.exit(1);")).toEqual([["crash", true, 1, "fixture crash"]]);
    });

    it("is written as non-fatal when that listener lets the process go on", () => {
        expect(crashWith("")).toEqual([["crash", false, null, "fixture crash"]]);
    });
});

describe("signalEnd", () => {
    const direct = { status: null, viaLauncher: false };

    it("records an outside signal as an interrupt and a fault signal as a crash", () => {
        expect(signalEnd({ signal: "SIGINT", ...direct })).toEqual({
            kind: "interrupt",
            signal: "SIGINT",
            exitCode: 130,
        });
        expect(signalEnd({ signal: "SIGTERM", ...direct })?.kind).toBe("interrupt");
        expect(signalEnd({ signal: "SIGHUP", ...direct })?.kind).toBe("interrupt");
        expect(signalEnd({ signal: "SIGKILL", ...direct })).toEqual({
            kind: "interrupt",
            signal: "SIGKILL",
            exitCode: 137,
        });
        expect(signalEnd({ signal: "SIGSEGV", ...direct })?.kind).toBe("crash");
        expect(signalEnd({ signal: "SIGABRT", ...direct })?.kind).toBe("crash");
    });

    it("gives every fault signal the platform's status, which the tools wrapper exits with too", () => {
        for (const name of ["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL", "SIGINT"] as const) {
            expect(signalExitStatus(name)).toBe(128 + constants.signals[name]);
        }
        expect(signalEnd({ signal: "SIGSEGV", ...direct })?.exitCode).toBe(128 + constants.signals.SIGSEGV);
    });

    it("is no failure for a signal that ends a run normally", () => {
        expect(signalEnd({ signal: "SIGPIPE", ...direct })).toBeNull();
        expect(signalEnd({ signal: null, ...direct })).toBeNull();
    });

    it("reads 128 + n as a signal only from the GenesisTools.app launcher", () => {
        expect(signalEnd({ signal: null, status: 143, viaLauncher: true })).toEqual({
            kind: "interrupt",
            signal: "SIGTERM",
            exitCode: 143,
        });
        expect(signalEnd({ signal: null, status: 134, viaLauncher: true })?.kind).toBe("crash");
        expect(signalEnd({ signal: null, status: 143, viaLauncher: false })).toBeNull();
        expect(signalEnd({ signal: null, status: 1, viaLauncher: true })).toBeNull();
        expect(signalOfStatus(128)).toBeNull();
        expect(signalOfStatus(130)).toBe("SIGINT");
    });
});

describe("recordSignalEnd", () => {
    const at = new Date(2026, 9, 22, 12);
    const end = (dir: string, runId: string, overrides: { signal?: string | null; status?: number | null } = {}) =>
        recordSignalEnd({
            tool: "fixture",
            runId,
            startedAt: new Date(at.getTime() - 5000),
            signal: overrides.signal === undefined ? "SIGINT" : overrides.signal,
            status: overrides.status ?? null,
            viaLauncher: true,
            childPid: 4242,
            toolsRoot: "/repo",
            caller: () => null,
            now: at,
            dir,
        });
    const all = (dir: string) => [...readFailures({ fromDay: "2026-10-22", toDay: "2026-10-22", dir })];

    it("writes one record with the argv withheld, no command and the signal named", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-failures-signal-"));
        const written = end(dir, "run-a");
        expect(written).toMatchObject({
            kind: "interrupt",
            tool: "fixture",
            command: null,
            argv: WITHHELD_ARGV,
            exitCode: 130,
            message: "ended by SIGINT",
            stderrTail: null,
            pid: 4242,
            durationMs: 5000,
            runId: "run-a",
        });
        expect(all(dir)).toEqual([written as ToolFailure]);
    });

    it("writes nothing when the tool already recorded this run, and still writes for another run", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-failures-signal-"));
        const own: ToolFailure = {
            v: 1,
            id: "own-1",
            at: at.toISOString(),
            kind: "interrupt",
            tool: "fixture",
            command: "fixture run",
            argv: ["run"],
            exitCode: 130,
            message: null,
            errorName: null,
            stack: null,
            stderrTail: null,
            fatal: true,
            durationMs: 10,
            pid: 4243,
            ppid: 4242,
            cwd: "/repo",
            traceId: null,
            toolsRoot: "/repo",
            caller: null,
            runId: "run-b",
        };
        appendFailure(own, dir);

        expect(end(dir, "run-b", { signal: null, status: 130 })).toBeNull();
        expect(end(dir, "run-c", { signal: null, status: 130 })?.message).toBe(
            "ended by SIGINT (exit 130 from the GenesisTools.app launcher)"
        );
        expect(all(dir).map((failure) => failure.runId)).toEqual(["run-b", "run-c"]);
    });
});

describe("a tool that handles its own interrupt under the tools wrapper", () => {
    it("records the wrapper's run id, hides it from child tools, and the wrapper adds no second record", () => {
        const home = mkdtempSync(join(tmpdir(), "gt-failures-runid-"));
        const script = [
            `import { watchToolRun } from "${join(import.meta.dir, "watch.ts")}";`,
            `watchToolRun({ tool: "fixture", argv: ["run"], caller: () => null });`,
            `process.stdout.write(process.env.${RUN_ID_ENV} ?? "gone");`,
            "process.exit(130);",
        ].join("\n");
        const startedAt = new Date();
        const child = Bun.spawnSync([process.execPath, "-e", script], {
            env: { ...process.env, GENESIS_TOOLS_HOME: home, [RUN_ID_ENV]: "run-wrapped", TZ: TEST_ZONE },
            stdout: "pipe",
            stderr: "ignore",
        });
        const dir = join(home, ".genesis-tools", "logs");
        const read = () =>
            [...readFailures({ fromDay: formatLocalDate(startedAt), toDay: formatLocalDate(new Date()), dir })].map(
                (record) => [record.kind, record.exitCode, record.runId]
            );

        expect(child.stdout.toString()).toBe("gone");
        expect(read()).toEqual([["interrupt", 130, "run-wrapped"]]);
        const second = recordSignalEnd({
            tool: "fixture",
            runId: "run-wrapped",
            startedAt,
            signal: null,
            status: child.exitCode,
            viaLauncher: true,
            childPid: child.pid,
            toolsRoot: "/repo",
            caller: () => null,
            dir,
        });
        expect(second).toBeNull();
        expect(read()).toHaveLength(1);
    });
});

// Characterization tests (2026-11-04): what a failure record says about its caller today, before the agent-context
// gatherers are unified. Every input is injected: the context, the env and the home are plain objects and a folder.
describe("characterization: the caller a failure record names", () => {
    const NOW = new Date(2026, 10, 4, 12, 0, 0);

    function context(overrides: Partial<AgentRuntimeContext>): AgentRuntimeContext {
        return {
            agent: "claude-code",
            sessionId: "11111111-2222-3333-4444-555555555555",
            isInAgent: true,
            aiAgent: null,
            sessionTitle: "Fixture session",
            project: "FixtureProject",
            repoRoot: "/fixture/FixtureProject",
            cwd: "/fixture/FixtureProject/sub",
            isWorktree: false,
            worktreePath: null,
            branch: "feat/fixture",
            commitSha: "abc1234",
            commitMessage: "fixture commit",
            ...overrides,
        };
    }

    /** The context a hook or a worker knows about the session, with no label: the host's env gives it. */
    function contextWithoutLabel(overrides: Partial<AgentRuntimeContext>): Partial<AgentRuntimeContext> {
        const { aiAgent: _label, ...given } = context(overrides);
        return given;
    }

    /** The env of a Claude session whose id the contexts above name: the identity module detects the host from it. */
    function claudeEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return { CLAUDE_CODE_SESSION_ID: context({}).sessionId ?? "", ...extra };
    }

    function scratch(): string {
        return mkdtempSync(join(tmpdir(), "failures-caller-"));
    }

    function put(path: string, text = ""): string {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, text);
        return path;
    }

    function claudeRow(model: string): string {
        return `${SafeJSON.stringify({ type: "assistant", message: { model, content: [] } })}\n`;
    }

    function codexRow(model: string): string {
        return `${SafeJSON.stringify({ type: "turn_context", payload: { model } })}\n`;
    }

    describe("the Claude transcript", () => {
        it("is projects/<cwd as folder>/<session>.jsonl under CLAUDE_CONFIG_DIR", () => {
            const config = scratch();
            const ctx = context({});
            const file = put(join(config, "projects", claudeProjectFolder(ctx.cwd), `${ctx.sessionId}.jsonl`));

            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBe(file);
        });

        it("tries the cwd first, then the repo root", () => {
            const config = scratch();
            const ctx = context({});
            const inRoot = put(join(config, "projects", claudeProjectFolder(ctx.repoRoot), `${ctx.sessionId}.jsonl`));
            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBe(inRoot);

            const inCwd = put(join(config, "projects", claudeProjectFolder(ctx.cwd), `${ctx.sessionId}.jsonl`));
            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBe(inCwd);
        });

        it("falls back to a scan of every project folder when neither name matches", () => {
            const config = scratch();
            const ctx = context({});
            const elsewhere = put(join(config, "projects", "-some-other-folder", `${ctx.sessionId}.jsonl`));

            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBe(elsewhere);
        });

        it("is null when no folder holds the session, or the config has no projects folder", () => {
            const config = scratch();
            const ctx = context({});
            put(join(config, "projects", "-some-other-folder", "another-session.jsonl"));

            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBeNull();
            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: scratch() } })).toBeNull();
        });

        it("reads ~/.claude of the given home when CLAUDE_CONFIG_DIR is unset or blank", () => {
            const home = scratch();
            const ctx = context({});
            const file = put(join(home, ".claude", "projects", claudeProjectFolder(ctx.cwd), `${ctx.sessionId}.jsonl`));

            expect(transcriptOf({ context: ctx, processEnv: {}, home })).toBe(file);
            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: "  " }, home })).toBe(file);
        });

        it("encodes Windows cwd separators and keeps punctuation in the session filename", () => {
            const config = scratch();
            const ctx = context({ cwd: "C:\\work\\My App.v2", sessionId: "thread:child%3Amcp ?#ž" });
            expect(claudeProjectFolder(ctx.cwd)).toBe("C--work-My-App-v2");
            expect(claudeProjectFolder("C:/work/My App.v2")).toBe("C--work-My-App-v2");
            const file = put(join(config, "projects", "C--work-My-App-v2", `${ctx.sessionId}.jsonl`));
            expect(transcriptOf({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } })).toBe(file);
        });

        it("a whitespace session id is a literal filename, while an empty id stops the lookup", () => {
            const config = scratch();
            const ctx = context({ sessionId: " \t " });
            const file = put(join(config, "projects", claudeProjectFolder(ctx.cwd), " \t .jsonl"));
            const processEnv = { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "env-session" };
            expect(transcriptOf({ context: ctx, processEnv })).toBe(file);
            expect(transcriptOf({ context: context({ sessionId: "" }), processEnv })).toBeNull();
        });

        it("is null for a caller with no session id", () => {
            const config = scratch();
            expect(
                transcriptOf({ context: context({ sessionId: null }), processEnv: { CLAUDE_CONFIG_DIR: config } })
            ).toBeNull();
        });
    });

    describe("the Codex transcript", () => {
        const THREAD = "01a0f4fc-171d-7c30-9679-ee00633dee2d";

        function rollout(codexHome: string, day: Date, ext = "jsonl"): string {
            const dir = join(
                codexHome,
                "sessions",
                String(day.getFullYear()),
                String(day.getMonth() + 1).padStart(2, "0"),
                String(day.getDate()).padStart(2, "0")
            );
            return put(join(dir, `rollout-2026-11-04T09-00-00-${THREAD}.${ext}`));
        }

        it("is found in the FIRST entry of the CODEX_HOME list, never in a later one", () => {
            const first = scratch();
            const second = scratch();
            rollout(second, NOW);
            const ctx = context({ agent: "codex", sessionId: THREAD });

            expect(
                transcriptOf({ context: ctx, processEnv: { CODEX_HOME: `${first},${second}` }, now: NOW })
            ).toBeNull();

            const file = rollout(first, NOW);
            expect(transcriptOf({ context: ctx, processEnv: { CODEX_HOME: ` ${first} , ${second}` }, now: NOW })).toBe(
                file
            );
        });

        it("looks back through today and the six days before, and no further", () => {
            const home = scratch();
            const ctx = context({ agent: "codex", sessionId: THREAD });
            const old = rollout(home, new Date(NOW.getTime() - 7 * 86_400_000));
            expect(transcriptOf({ context: ctx, processEnv: { CODEX_HOME: home }, now: NOW })).toBeNull();

            const sixBack = rollout(home, new Date(NOW.getTime() - 6 * 86_400_000));
            expect(old).not.toBe(sixBack);
            expect(transcriptOf({ context: ctx, processEnv: { CODEX_HOME: home }, now: NOW })).toBe(sixBack);
        });

        it("a CODEX_HOME list of only blank entries falls back to the injected home", () => {
            const home = scratch();
            const ctx = context({ agent: "codex", sessionId: THREAD });
            const file = rollout(join(home, ".codex"), NOW);
            expect(transcriptOf({ context: ctx, processEnv: { CODEX_HOME: " , \t , " }, now: NOW, home })).toBe(file);
        });

        it("takes a compressed rollout too, and reads ~/.codex of the given home when CODEX_HOME is unset", () => {
            const home = scratch();
            const ctx = context({ agent: "codex", sessionId: THREAD });
            const file = rollout(join(home, ".codex"), NOW, "jsonl.zst");

            expect(transcriptOf({ context: ctx, processEnv: {}, now: NOW, home })).toBe(file);
        });
    });

    it("Grok, Copilot and an unknown caller have no transcript looked up", () => {
        for (const agent of ["grok", "copilot", "unknown"] as const) {
            expect(transcriptOf({ context: context({ agent }), processEnv: {} })).toBeNull();
        }
    });

    describe("failureCaller", () => {
        it("takes no AI_AGENT for Codex (an outer host's label) and saves the session's cwd", () => {
            const ctx = context({ agent: "codex", aiAgent: null, cwd: "/fixture/repo/sub" });
            const caller = failureCaller({ context: ctx, processEnv: { AI_AGENT: "label" }, home: scratch() });
            expect(caller.aiAgent).toBeNull();
            expect(caller.cwd).toBe("/fixture/repo/sub");
            // A host that takes a label gives it as the harness sets it: the identity module reads it from the env.
            expect(
                failureCaller({ context: contextWithoutLabel({}), processEnv: claudeEnv({ AI_AGENT: " label " }) })
                    .aiAgent
            ).toBe(" label ");
            const dir = scratch();
            const failure: ToolFailure = {
                v: 1,
                id: "failure-1",
                at: "2026-11-04T12:00:00.000Z",
                kind: "error",
                tool: "fixture",
                command: null,
                argv: [],
                exitCode: 1,
                message: "failed",
                errorName: null,
                stack: null,
                stderrTail: null,
                fatal: false,
                durationMs: 3,
                pid: 1,
                ppid: 2,
                cwd: ctx.cwd,
                traceId: null,
                toolsRoot: "/fixture/tools",
                caller,
            };
            appendFailure(failure, dir);
            const stored = SafeJSON.parse(
                readFileSync(failureLogPath(formatLocalDate(new Date(failure.at)), dir), "utf8"),
                { strict: true }
            );
            expect(stored).toEqual(failure);
            expect(stored.caller).toEqual({
                agent: "codex",
                sessionId: ctx.sessionId,
                sessionTitle: "Fixture session",
                model: null,
                effort: null,
                aiAgent: null,
                project: "FixtureProject",
                repoRoot: "/fixture/FixtureProject",
                cwd: "/fixture/repo/sub",
                branch: "feat/fixture",
                commitSha: "abc1234",
                worktreePath: null,
            });
        });
        it("reads the model of a Claude session from the newest assistant row of its transcript", () => {
            const config = scratch();
            const ctx = context({});
            put(
                join(config, "projects", claudeProjectFolder(ctx.cwd), `${ctx.sessionId}.jsonl`),
                claudeRow("model-old") + claudeRow("model-new")
            );

            expect(failureCaller({ context: ctx, processEnv: { CLAUDE_CONFIG_DIR: config } }).model).toBe("model-new");
        });

        it("reads the model of a Codex session from the newest turn_context row of its rollout", () => {
            const home = scratch();
            const ctx = context({ agent: "codex", sessionId: "01a0f4fc-171d-7c30-9679-ee00633dee2d" });
            const day = NOW;
            put(
                join(
                    home,
                    "sessions",
                    String(day.getFullYear()),
                    String(day.getMonth() + 1).padStart(2, "0"),
                    String(day.getDate()).padStart(2, "0"),
                    `rollout-x-${ctx.sessionId}.jsonl`
                ),
                codexRow("codex-old") + codexRow("codex-new")
            );

            expect(failureCaller({ context: ctx, processEnv: { CODEX_HOME: home }, now: NOW }).model).toBe("codex-new");
        });

        it("has no model when there is no transcript, and none for Grok or an unknown caller", () => {
            const config = scratch();
            expect(failureCaller({ context: context({}), processEnv: { CLAUDE_CONFIG_DIR: config } }).model).toBeNull();
            expect(failureCaller({ context: context({ agent: "grok" }), processEnv: {} }).model).toBeNull();
            expect(
                failureCaller({ context: context({ agent: "unknown", sessionId: null }), processEnv: {} }).model
            ).toBeNull();
        });

        it("takes the effort from the Claude host's CLAUDE_EFFORT, trimmed, and null when blank or unset", () => {
            expect(
                failureCaller({ context: context({}), processEnv: claudeEnv({ CLAUDE_EFFORT: " high " }) }).effort
            ).toBe("high");
            expect(
                failureCaller({ context: context({}), processEnv: claudeEnv({ CLAUDE_EFFORT: "  " }) }).effort
            ).toBeNull();
            expect(failureCaller({ context: context({}), processEnv: claudeEnv({}) }).effort).toBeNull();
        });

        it("takes no effort from CLAUDE_EFFORT for a host that is not Claude", () => {
            const codexEnv = { CODEX_THREAD_ID: "01a0f4fc-171d-7c30-9679-ee00633dee2d", CLAUDE_EFFORT: "low" };
            expect(failureCaller({ context: context({ agent: "codex" }), processEnv: codexEnv }).effort).toBeNull();
        });

        it("an empty or whitespace context label blocks the nonblank AI_AGENT fallback", () => {
            for (const aiAgent of ["", " \t "]) {
                const caller = failureCaller({
                    context: context({ agent: "unknown", sessionId: null, aiAgent }),
                    processEnv: { AI_AGENT: "fallback-label" },
                });
                expect(caller.aiAgent).toBe(aiAgent);
                expect(caller.model).toBeNull();
            }
        });

        it("copies the agent, session and checkout from the context, and the label from the context before the env's AI_AGENT", () => {
            const ctx = context({ aiAgent: "from-context" });
            expect(failureCaller({ context: ctx, processEnv: { AI_AGENT: "from-env" } })).toEqual({
                agent: "claude-code",
                sessionId: "11111111-2222-3333-4444-555555555555",
                sessionTitle: "Fixture session",
                model: null,
                effort: null,
                aiAgent: "from-context",
                project: "FixtureProject",
                repoRoot: "/fixture/FixtureProject",
                cwd: "/fixture/FixtureProject/sub",
                branch: "feat/fixture",
                commitSha: "abc1234",
                worktreePath: null,
            });
            expect(
                failureCaller({ context: contextWithoutLabel({}), processEnv: claudeEnv({ AI_AGENT: " from-env " }) })
                    .aiAgent
            ).toBe(" from-env ");
            expect(failureCaller({ context: contextWithoutLabel({}), processEnv: claudeEnv({}) }).aiAgent).toBeNull();
        });
    });
});

// The saved-record facts of 2026-11-05 (decision 11 a): optional fields, so the reader needs no migration.
describe("the failure record's caller facts", () => {
    const OLD_LINE: ToolFailure = {
        v: 1,
        id: "f-old-1",
        at: "2026-11-03T10:00:00.000Z",
        kind: "exit",
        tool: "open",
        command: null,
        argv: ["-g"],
        exitCode: 1,
        message: null,
        errorName: null,
        stack: null,
        stderrTail: null,
        fatal: true,
        durationMs: 12,
        pid: 101,
        ppid: 100,
        cwd: "/fixture/repo",
        traceId: null,
        toolsRoot: "/fixture/tools",
        // The caller as a record from before 2026-11-04 wrote it: no cwd, and none of the facts below.
        caller: {
            agent: "claude-code",
            sessionId: "s-old",
            sessionTitle: null,
            model: "model-1",
            effort: null,
            aiAgent: null,
            project: "repo",
            repoRoot: "/fixture/repo",
            branch: "main",
            commitSha: "abc1234",
            worktreePath: null,
        },
    };

    it("an old record without the facts and a new one with them both read back, each as written", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-failures-facts-"));
        const day = "2026-11-05";
        const path = failureLogPath(day, dir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, `${SafeJSON.stringify(OLD_LINE)}\n`);
        const fresh: ToolFailure = {
            ...OLD_LINE,
            id: "f-new-1",
            at: new Date(2026, 10, 5, 12).toISOString(),
            caller: {
                agent: "codex",
                sessionId: "t1",
                sessionTitle: null,
                model: "model-1",
                effort: null,
                aiAgent: null,
                project: "repo",
                repoRoot: "/fixture/repo",
                branch: "main",
                commitSha: "abc1234",
                worktreePath: null,
                cwd: "/fixture/repo",
                transcriptPath: "/fixture/.codex/sessions/rollout-t1.jsonl",
                toolUseId: "exec-1",
                subagentId: "t1",
                account: { harness: "codex", account: "work", proxyTarget: null },
                host: { app: "t3code", threadId: "thread:1", providerInstanceId: "gt-codex-work" },
            },
        };
        appendFailure(fresh, dir);

        const [old, now] = [...readFailures({ fromDay: day, toDay: day, dir })];
        expect(old).toEqual(OLD_LINE);
        expect(old?.caller?.transcriptPath).toBeUndefined();
        expect(old?.caller?.host).toBeUndefined();
        expect(now).toEqual(fresh);
    });

    it("a Codex subagent run keeps its transcript, tool call, subagent, account and T3 thread", () => {
        const home = mkdtempSync(join(tmpdir(), "gt-failures-codex-"));
        const thread = "01a195d5-8f1b-78f0-9c7c-24d0dd290d30";
        const rollout = join(home, "sessions", "2026", "11", "05", `rollout-2026-11-05T09-00-00-${thread}.jsonl`);
        mkdirSync(join(rollout, ".."), { recursive: true });
        writeFileSync(rollout, `${SafeJSON.stringify({ type: "turn_context", payload: { model: "sub-model" } })}\n`);
        const caller = failureCaller({
            processEnv: {
                CODEX_SESSION_ID: "01a195ae-e4aa-7cb0-b579-8974a4580b9b",
                CODEX_THREAD_ID: thread,
                CODEX_TOOL_CALL_ID: "exec-1",
                CODEX_HOME: home,
                TOOLS_CODEX_ACCOUNT: "side",
                T3CODE_THREAD_ID: "thread:1",
                T3CODE_HOME: join(home, "no-t3"),
            },
            context: {
                cwd: "/fixture/repo",
                repoRoot: "/fixture/repo",
                project: "repo",
                branch: "main",
                commitSha: "abc1234",
                worktreePath: null,
                sessionTitle: null,
            },
            now: new Date(2026, 10, 5, 12, 0, 0),
        });

        expect(caller).toMatchObject({
            agent: "codex",
            sessionId: thread,
            model: "sub-model",
            transcriptPath: rollout,
            toolUseId: "exec-1",
            subagentId: thread,
            account: { harness: "codex", account: "side", proxyTarget: null },
            host: { app: "t3code", threadId: "thread:1" },
        });
        expect(caller.turnId).toBeUndefined();
    });

    it("a caller the identity knows none of the facts for writes exactly the old keys", () => {
        const caller = failureCaller({
            processEnv: {},
            context: {
                cwd: "/fixture/repo",
                repoRoot: "/fixture/repo",
                project: "repo",
                branch: null,
                commitSha: null,
                worktreePath: null,
                sessionTitle: null,
            },
        });

        expect(Object.keys(caller).sort()).toEqual(
            [
                "agent",
                "sessionId",
                "sessionTitle",
                "model",
                "effort",
                "aiAgent",
                "project",
                "repoRoot",
                "cwd",
                "branch",
                "commitSha",
                "worktreePath",
            ].sort()
        );
    });
});

describe("a command deadline record", () => {
    const today = () => formatLocalDate(new Date());
    const deadlines = (marker: string) =>
        [...readFailures({ fromDay: today(), toDay: today() })].filter(
            (failure) => failure.kind === "deadline" && failure.child?.command.includes(marker)
        );
    const seams = { record: deadlineRecording.boundMs, caller: deadlineCaller.boundMs, lookup: deadlineCaller.lookup };

    afterEach(() => {
        deadlineRecording.boundMs = seams.record;
        deadlineCaller.boundMs = seams.caller;
        deadlineCaller.lookup = seams.lookup;
    });

    it("writes one record per expiry with the call's stack and the child, and no caller when the read hangs", async () => {
        deadlineCaller.boundMs = 100;
        deadlineCaller.lookup = () => new Promise(() => {});
        const marker = `marker-${process.pid}-a`;

        await expect(
            new Executor({ timeout: 200 }).exec(["sh", "-c", "sleep 5", marker], { cwd: tmpdir() })
        ).rejects.toThrow("Command timed out after 200ms (its Executor's bound)");

        const records = deadlines(marker);
        expect(records).toHaveLength(1);
        const [record] = records;
        expect(record).toMatchObject({
            kind: "deadline",
            fatal: false,
            exitCode: null,
            caller: null,
            pid: process.pid,
            child: {
                command: ["sh", "-c", "sleep 5", marker],
                cwd: tmpdir(),
                timeoutMs: 200,
                defaulted: false,
                reason: null,
            },
        });
        expect(record.message).toBe(`Command timed out after 200ms (its Executor's bound): sh -c sleep 5 ${marker}`);
        expect(record.stack).toContain("failures.test.ts");
        expect(record.durationMs).toBeGreaterThanOrEqual(150);
        expect(record.runId).toBeUndefined();
    });

    it("stores the child and the message with URL credentials and the value of -u user:password hidden", async () => {
        deadlineCaller.lookup = async () => null;
        const marker = `marker-${process.pid}-e`;
        const url = "https://alice:example123@example.com/repo";

        await expect(
            new Executor({ timeout: 200 }).exec(["sh", "-c", "sleep 5", marker, url, "-u", "alice:example123"])
        ).rejects.toThrow("-u ***");

        const [record] = deadlines(marker);
        expect(record?.child?.command).toEqual([
            "sh",
            "-c",
            "sleep 5",
            marker,
            "https://alice:[redacted]@example.com/repo",
            "-u",
            "***",
        ]);
        expect(record?.message).toBe(
            `Command timed out after 200ms (its Executor's bound): sh -c sleep 5 ${marker} https://alice:[redacted]@example.com/repo -u ***`
        );
        expect(SafeJSON.stringify(record)).not.toContain("example123");
    });

    it("keeps the reason of an explicit { ms, reason } and the caller the lookup gives", async () => {
        deadlineCaller.lookup = async () => failureCallerOf(whoIsCalling({ origin: "local", env: {} }));
        const marker = `marker-${process.pid}-b`;

        await expect(
            new Executor().exec(["sh", "-c", "sleep 5", marker], { timeout: { ms: 200, reason: "a test bound" } })
        ).rejects.toThrow("this call's bound: a test bound");

        const [record] = deadlines(marker);
        expect(record?.child).toMatchObject({ timeoutMs: 200, defaulted: false, reason: "a test bound" });
        expect(record?.caller?.agent).toBe("unknown");
    });

    it("throws within the record bound when the record step hangs", async () => {
        deadlineRecording.boundMs = 300;
        deadlineCaller.boundMs = 2_500;
        deadlineCaller.lookup = () => new Promise(() => {});
        const started = performance.now();

        await expect(
            new Executor({ timeout: 200 }).exec(["sh", "-c", "sleep 5", `marker-${process.pid}-c`])
        ).rejects.toThrow("Command timed out after 200ms");
        // 200 ms of child, 300 ms of record bound, and the group kill's own escalation (up to 600 ms).
        expect(performance.now() - started).toBeLessThan(1_500);
    });

    it("writes no record for a command that ends in time", async () => {
        const before = [...readFailures({ fromDay: today(), toDay: today() })].length;

        await new Executor({ timeout: 2_000 }).exec(["sh", "-c", "true", `marker-${process.pid}-d`]);

        expect([...readFailures({ fromDay: today(), toDay: today() })]).toHaveLength(before);
    });

    it("writes the record on a worker thread, and gives up on it at its bound", async () => {
        const dir = mkdtempSync(join(tmpdir(), "deadline-write-"));
        const failure: ToolFailure = {
            v: 1,
            id: `deadline-write-${process.pid}`,
            at: new Date().toISOString(),
            kind: "deadline",
            tool: "fixture",
            command: null,
            argv: [],
            exitCode: null,
            message: "Command timed out after 1ms",
            errorName: "Error",
            stack: null,
            stderrTail: null,
            fatal: false,
            durationMs: 1,
            pid: process.pid,
            ppid: process.ppid,
            cwd: dir,
            traceId: null,
            toolsRoot: dir,
            caller: null,
        };

        // The main thread is busy while the worker writes, so the write is not on it.
        const written = deadlineWrite.write(failure, dir, 5_000);
        expect(readdirSync(dir)).toEqual([]);
        expect(await written).toBe(true);
        expect([...readFailures({ fromDay: today(), toDay: today(), dir })].map((f) => f.id)).toEqual([failure.id]);

        expect(await deadlineWrite.write(failure, join(dir, "late"), 0)).toBe(false);
    });
});
