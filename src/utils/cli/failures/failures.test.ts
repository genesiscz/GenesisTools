import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { Command } from "commander";
import { claudeProjectFolder, modelInTranscriptLines } from "./caller";
import { recordSignalEnd, signalEnd, signalOfStatus, WITHHELD_ARGV } from "./launcher";
import { appendFailure, readFailures, type ToolFailure } from "./record";
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
            env: { ...process.env, GENESIS_TOOLS_HOME: home },
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
            env: { ...process.env, GENESIS_TOOLS_HOME: home, [RUN_ID_ENV]: "run-wrapped" },
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
