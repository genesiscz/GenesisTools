import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { buildLaunchArgs, cmuxPermissionArgs, passthroughHandlesSession, splitStartOperands } from "./start";

describe("splitStartOperands", () => {
    const argv = (...rest: string[]) => ["bun", "claude", "run", ...rest];

    test("a name before -- is the account, the rest goes to claude", () => {
        expect(
            splitStartOperands({ name: "work", operands: ["work", "-p", "hi"], argv: argv("work", "--", "-p", "hi") })
        ).toEqual({
            nameArg: "work",
            passthrough: ["-p", "hi"],
        });
    });

    test("a prompt after -- with no name is passed through, never used as the account", () => {
        expect(
            splitStartOperands({ name: "fix the bug", operands: ["fix the bug"], argv: argv("--", "fix the bug") })
        ).toEqual({
            nameArg: undefined,
            passthrough: ["fix the bug"],
        });
    });

    test("a leading-dash operand is passthrough", () => {
        expect(splitStartOperands({ name: "--foo", operands: ["--foo"], argv: argv("--", "--foo") })).toEqual({
            nameArg: undefined,
            passthrough: ["--foo"],
        });
    });

    test("a name without -- keeps the old behaviour", () => {
        expect(splitStartOperands({ name: "work", operands: ["work"], argv: argv("work", "-m", "opus") })).toEqual({
            nameArg: "work",
            passthrough: [],
        });
    });
});

describe("cmuxPermissionArgs", () => {
    test("injects the bypass because cmux claude-teams execs past the ccc wrapper", () => {
        expect(cmuxPermissionArgs([])).toEqual(["--dangerously-skip-permissions"]);
    });

    test("an explicit permission choice always wins", () => {
        expect(cmuxPermissionArgs(["--dangerously-skip-permissions"])).toEqual([]);
        expect(cmuxPermissionArgs(["--permission-mode", "plan"])).toEqual([]);
        expect(cmuxPermissionArgs(["--permission-mode=plan"])).toEqual([]);
    });

    test("an unrelated flag that merely mentions permissions does not count", () => {
        expect(cmuxPermissionArgs(["--print", "describe --permission-mode"])).toEqual([
            "--dangerously-skip-permissions",
        ]);
    });
});

describe("buildLaunchArgs", () => {
    test("injected permission flag precedes a positional prompt", () => {
        const args = buildLaunchArgs({ resumeArgs: [], passthrough: ["do the thing"], cmux: true });

        expect(args).toEqual(["--dangerously-skip-permissions", "do the thing"]);
    });

    test("injected permission flag precedes a -- separator", () => {
        const args = buildLaunchArgs({ resumeArgs: [], passthrough: ["--", "-p", "hi"], cmux: true });

        expect(args.indexOf("--dangerously-skip-permissions")).toBeLessThan(args.indexOf("--"));
    });

    test("model comes first and forwarded args keep their order", () => {
        const args = buildLaunchArgs({
            modelId: "claude-fable-5",
            resumeArgs: ["--resume", "abc"],
            passthrough: ["-p", "hi"],
            cmux: true,
        });

        expect(args).toEqual([
            "--model",
            "claude-fable-5",
            "--dangerously-skip-permissions",
            "--resume",
            "abc",
            "-p",
            "hi",
        ]);
    });

    test("without --cmux nothing is injected", () => {
        const args = buildLaunchArgs({ resumeArgs: ["--continue"], passthrough: ["-p"], cmux: false });

        expect(args).toEqual(["--continue", "-p"]);
    });
});

describe("passthroughHandlesSession", () => {
    test("--agent-id counts so teammate attach does not open the limit-killed picker", () => {
        expect(passthroughHandlesSession(["--agent-id", "pageobjects-fable@session-8f96d99f"])).toBe(true);
    });

    test("bare teammate-unrelated flags do not", () => {
        expect(passthroughHandlesSession(["--model", "fable"])).toBe(false);
    });
});

interface DirectProcessFixture {
    exitCode: number | null;
    exited: Promise<number>;
    kill: (signal: string) => void;
}

type DirectRunner = (argv: string[], environment: Record<string, string>) => Promise<number>;

/** Execute the actual private launch function with fake process signals and no child process. */
async function directRunner(spawn: () => DirectProcessFixture, signals: EventEmitter): Promise<DirectRunner> {
    const source = await Bun.file(new URL("./start.ts", import.meta.url)).text();
    const declaration = source.match(/async function runClaudeBinaryDirect[\s\S]*?\n}/)?.[0];
    expect(declaration).toBeDefined();
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(declaration ?? "");
    const factory = new Function("Bun", "process", `${code}\nreturn runClaudeBinaryDirect;`);
    const run: DirectRunner = factory({ spawn }, signals);
    return run;
}

describe("direct SDK launch signals", () => {
    const names = ["SIGTERM", "SIGINT", "SIGHUP"];

    test("registers before spawn and forwards an early signal once the child exists", async () => {
        const signals = new EventEmitter();
        const killed: string[] = [];
        const proc = { exitCode: null, exited: Promise.resolve(143), kill: (signal: string) => killed.push(signal) };
        const run = await directRunner(() => {
            expect(names.map((name) => signals.listenerCount(name))).toEqual([1, 1, 1]);
            signals.emit("SIGTERM", "SIGTERM");
            return proc;
        }, signals);

        expect(await run(["fixture"], {})).toBe(143);
        expect(killed).toEqual(["SIGTERM"]);
        expect(names.map((name) => signals.listenerCount(name))).toEqual([0, 0, 0]);
    });

    test("removes every handler if spawning throws", async () => {
        const signals = new EventEmitter();
        const run = await directRunner(() => {
            throw new Error("spawn failed");
        }, signals);

        await expect(run(["fixture"], {})).rejects.toThrow("spawn failed");
        expect(names.map((name) => signals.listenerCount(name))).toEqual([0, 0, 0]);
    });

    test("forwards running-child signals and never kills a child that already exited", async () => {
        const signals = new EventEmitter();
        const killed: string[] = [];
        const proc: DirectProcessFixture = {
            exitCode: null,
            exited: Promise.resolve(0),
            kill: (signal) => {
                killed.push(signal);
            },
        };
        const run = await directRunner(() => proc, signals);
        const result = run(["fixture"], {});
        signals.emit("SIGINT", "SIGINT");
        proc.exitCode = 0;
        signals.emit("SIGHUP", "SIGHUP");

        expect(await result).toBe(0);
        expect(killed).toEqual(["SIGINT"]);
        expect(names.map((name) => signals.listenerCount(name))).toEqual([0, 0, 0]);
    });
});
