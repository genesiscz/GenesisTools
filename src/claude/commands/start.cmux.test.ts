import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScoredAccount } from "@app/claude/lib/usage/account-picker";
import { type DirectRunDeps, pumpLines, rewriteSteerLine, runClaudeBinaryDirect } from "../lib/direct-run";
import { isHostProbe, readEmbedLastPick, writeEmbedLastPick } from "../lib/embed-pick";
import {
    buildLaunchArgs,
    cmuxPermissionArgs,
    passthroughHandlesSession,
    resumedSessionIdOf,
    splitStartOperands,
    stickyResumePick,
} from "./start";

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
    stdin?: unknown;
}

type DirectRunner = (argv: string[], environment: Record<string, string>) => Promise<number>;

/** The real launch function with fake process signals and no child process. */
function directRunner(spawn: () => DirectProcessFixture, signals: EventEmitter): DirectRunner {
    const deps: DirectRunDeps = {
        spawn,
        signals: {
            on: (name: string, listener: (...args: unknown[]) => void) => signals.on(name, listener),
            off: (name: string, listener: (...args: unknown[]) => void) => signals.off(name, listener),
        } as DirectRunDeps["signals"],
        stdin: () => new ReadableStream(),
    };

    return (argv, environment) => runClaudeBinaryDirect({ argv, env: environment }, deps);
}

describe("direct SDK launch signals", () => {
    const names = ["SIGTERM", "SIGINT", "SIGHUP"];

    test("registers before spawn and forwards an early signal once the child exists", async () => {
        const signals = new EventEmitter();
        const killed: string[] = [];
        const proc = { exitCode: null, exited: Promise.resolve(143), kill: (signal: string) => killed.push(signal) };
        const run = directRunner(() => {
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
        const run = directRunner(() => {
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
        const run = directRunner(() => proc, signals);
        const result = run(["fixture"], {});
        signals.emit("SIGINT", "SIGINT");
        proc.exitCode = 0;
        signals.emit("SIGHUP", "SIGHUP");

        expect(await result).toBe(0);
        expect(killed).toEqual(["SIGINT"]);
        expect(names.map((name) => signals.listenerCount(name))).toEqual([0, 0, 0]);
    });
});

describe("steer priority rewrite", () => {
    const steer =
        '{"type":"user","message":{"role":"user","content":"stop that"},"parent_tool_use_id":null,"priority":"now"}';

    test("a now user message becomes next, and nothing else changes", () => {
        expect(rewriteSteerLine(`${steer}\n`)).toBe(`${steer.replace('"now"', '"next"')}\n`);
        expect(rewriteSteerLine(steer)).toBe(steer.replace('"now"', '"next"'));
    });

    test("other lines pass byte for byte", () => {
        const next = steer.replace('"now"', '"next"');
        const control = '{"type":"control_request","request":{"subtype":"interrupt"},"note":"now"}\n';

        expect(rewriteSteerLine(`${next}\n`)).toBe(`${next}\n`);
        expect(rewriteSteerLine(control)).toBe(control);
        expect(rewriteSteerLine('not json "now"\n')).toBe('not json "now"\n');
        expect(rewriteSteerLine('{"type":"user","priority":"now"}\r\n')).toBe('{"type":"user","priority":"next"}\r\n');
    });

    test("the pump rewrites across chunk splits and closes the child's stdin", async () => {
        const encoder = new TextEncoder();
        const text = `${steer}\n{"type":"user","priority":"later"}\n${steer}`;
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(text.slice(0, 30)));
                controller.enqueue(encoder.encode(text.slice(30, 140)));
                controller.enqueue(encoder.encode(text.slice(140)));
                controller.close();
            },
        });
        const written: string[] = [];
        let ended = false;
        await pumpLines(
            source,
            { write: (chunk: string) => written.push(chunk), flush: () => undefined, end: () => (ended = true) },
            rewriteSteerLine
        );

        expect(written.join("")).toBe(text.replaceAll('"now"', '"next"'));
        expect(ended).toBe(true);
    });
});

describe("resumedSessionIdOf", () => {
    test("reads --resume=<id>, --resume <id> and -r <id>", () => {
        expect(resumedSessionIdOf(["--output-format", "stream-json", "--resume=abc-123"])).toBe("abc-123");
        expect(resumedSessionIdOf(["--resume", "abc-456", "--model", "m"])).toBe("abc-456");
        expect(resumedSessionIdOf(["-r", "abc-789"])).toBe("abc-789");
    });

    test("a new session or a bare --resume names nothing", () => {
        expect(resumedSessionIdOf(["--session-id=abc-123"])).toBeNull();
        expect(resumedSessionIdOf(["--resume"])).toBeNull();
        expect(resumedSessionIdOf(["--resume", "--model"])).toBeNull();
    });
});

describe("stickyResumePick", () => {
    const account = (accountName: string, over: Partial<ScoredAccount> = {}): ScoredAccount => ({
        accountName,
        tier: "ready",
        group: "opus",
        score: 1,
        cooling: false,
        surplus: false,
        bindingResetHours: 24,
        weeklyRatePctPerHour: 1,
        sessionHeadroomPct: 80,
        weeklyHeadroomPct: 80,
        sessionUsableFraction: 1,
        why: "",
        ...over,
    });

    test("keeps the resumed session's account while it can serve", () => {
        const scored = [account("work"), account("personal")];

        expect(stickyResumePick(scored, "personal")?.accountName).toBe("personal");
    });

    test("picks again when that account is spent, gone or unknown", () => {
        expect(
            stickyResumePick([account("work"), account("personal", { tier: "session-starved" })], "personal")
        ).toBeNull();
        expect(
            stickyResumePick([account("work"), account("personal", { tier: "weekly-blocked" })], "personal")
        ).toBeNull();
        expect(stickyResumePick([account("work"), account("personal", { group: "dead" })], "personal")).toBeNull();
        expect(
            stickyResumePick([account("work"), account("personal", { subscriptionExpired: true })], "personal")
        ).toBeNull();
        expect(stickyResumePick([account("work")], "personal")).toBeNull();
        expect(stickyResumePick([account("work")], null)).toBeNull();
    });
});

describe("host probe launches", () => {
    test("a T3 capability probe is a probe; a thread launch is not", () => {
        const probe = ["--output-format", "stream-json", "--no-session-persistence", "--settings", "{}"];

        expect(isHostProbe(probe)).toBe(true);
        expect(isHostProbe([...probe, "--resume=abc"])).toBe(false);
        expect(isHostProbe(["--session-id=abc", "--output-format", "stream-json"])).toBe(false);
    });

    test("the last pick round-trips and is dropped when the account is gone", () => {
        const path = join(mkdtempSync(join(tmpdir(), "embed-pick-")), "last.json");

        expect(readEmbedLastPick(["work"], path)).toBeNull();
        writeEmbedLastPick("work", path);
        expect(readEmbedLastPick(["work", "personal"], path)).toBe("work");
        expect(readEmbedLastPick(["personal"], path)).toBeNull();
    });
});
