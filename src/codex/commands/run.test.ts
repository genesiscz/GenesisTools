import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionQueueCommand } from "@app/ai/commands/agent/queue";
import { enqueueSessionMessage, listSessionMessages } from "@genesiscz/utils/agent-sessions/message-queue";
import { WorkerDeliveryRejectedError } from "@genesiscz/utils/worker/delivery";
import type { WorkerVerbOutcome } from "@genesiscz/utils/worker/driver";
import { Command } from "commander";
import * as controlChannel from "../lib/control-channel";
import { codexDriver } from "../lib/driver";
import { CodexMessageUnknownError, steerCodexMessage } from "../lib/message-delivery";
import type { CodexSessionMeta } from "../lib/store";
import { registerCodexMessageCommands } from "./queue";
import { nativeRunInvocation, registerRunCommand } from "./run";

test("run forwards native arguments through account-bound validation before starting processes", async () => {
    const program = new Command().exitOverride();
    registerRunCommand(program, { positional: true });
    await expect(
        program.parseAsync(["run", "work", "--", "--remote", "ws://another"], { from: "user" })
    ).rejects.toThrow("does not accept");
});

test("only a real run invocation asks for positional option parsing", () => {
    expect(nativeRunInvocation(["run", "work"])).toBe(true);
    expect(nativeRunInvocation(["-v", "start", "work"])).toBe(true);
    expect(nativeRunInvocation(["sessions", "-v"])).toBe(false);
    expect(nativeRunInvocation(["history", "run"])).toBe(false);
    expect(nativeRunInvocation([])).toBe(false);
});

test("registering run leaves the global -v usable after a sibling subcommand", async () => {
    // Regression: enablePositionalOptions() on the shared root made `tools codex <any> -v`
    // exit 1 with "unknown option '-v'" for every subcommand, not just run.
    const program = new Command().exitOverride().option("-v, --verbose", "Enable verbose logging");
    let verbose = false;
    program.command("sessions").action(() => {
        verbose = program.opts().verbose === true;
    });
    registerRunCommand(program, { positional: false });
    await program.parseAsync(["sessions", "-v"], { from: "user" });
    expect(verbose).toBe(true);
});

function queueMessageId(value: unknown): string {
    if (
        typeof value !== "object" ||
        value === null ||
        !("message" in value) ||
        typeof value.message !== "object" ||
        value.message === null ||
        !("id" in value.message) ||
        typeof value.message.id !== "string"
    ) {
        throw new Error("Expected a queued message receipt.");
    }

    return value.message.id;
}

function codexMessageFixture(overrides: Partial<CodexSessionMeta> = {}): CodexSessionMeta {
    return {
        name: "work",
        threadId: "thread-1",
        daemonPid: 123,
        cwd: "/fixture/project",
        home: "/fixture/codex",
        sandbox: "read-only",
        approvalPolicy: "never",
        writePolicy: "deny",
        status: "ready",
        agentName: "work",
        rendezvousSession: "fixture-parent",
        agentsEnabled: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        lastEventAt: "2026-01-01T00:00:00.000Z",
        codexVersion: "0.159.2",
        pendingApprovals: {},
        ...overrides,
    };
}

test("portable queue CLI requires an exact home and provides offer/read/ACK under all three providers", async () => {
    for (const provider of ["claude", "codex", "grok"] as const) {
        const root = mkdtempSync(join(tmpdir(), "gt-queue-cli-"));
        let receipt: unknown;
        const run = async (args: string[]) => {
            const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
            registerSessionQueueCommand({
                program,
                provider,
                output: (value) => {
                    receipt = value;
                },
            });
            await program.parseAsync(args, { from: "user" });
            return receipt;
        };
        const address = ["--session", "fixture-session", "--home", "/fixture/home", "--queue-root", root];
        const queued = await run(["queue", ...address, "--prompt", "fixture payload", "--idempotency-key", "once"]);
        expect(queued).toMatchObject({ delivered: false, queued: true, message: { target: { provider } } });
        const id = queueMessageId(queued);
        expect(
            queueMessageId(await run(["queue", ...address, "--prompt", "fixture payload", "--idempotency-key", "once"]))
        ).toBe(id);

        await run(["queue", "list", ...address]);
        expect(receipt).toMatchObject({ messages: [{ id, state: "queued", text: "fixture payload" }] });
        await expect(run(["queue", "ack", id, ...address, "--consumer", "receiver"])).rejects.toThrow(
            "Only the consumer"
        );
        await run(["queue", "offer", id, ...address, "--consumer", "receiver"]);
        expect(receipt).toMatchObject({ delivered: false, message: { state: "offered", consumer: "receiver" } });
        await expect(run(["queue", "ack", id, ...address, "--consumer", "other"])).rejects.toThrow("Only the consumer");
        await run(["queue", "ack", id, ...address, "--consumer", "receiver"]);
        expect(receipt).toMatchObject({ delivered: true, message: { state: "received" } });
        await expect(run(["queue", "offer", id, ...address, "--consumer", "receiver"])).rejects.toThrow(
            "already offered"
        );

        const cancelled = await run(["queue", ...address, "--prompt", "cancel this", "--idempotency-key", "cancel"]);
        await run(["queue", "cancel", queueMessageId(cancelled), ...address]);
        expect(receipt).toMatchObject({ delivered: false, message: { state: "cancelled" } });
        await expect(run(["queue", "--session", "fixture-session", "--prompt", "missing home"])).rejects.toThrow(
            "--home"
        );
        await expect(
            run(["queue", "--session", "fixture-session", "--home", "relative", "--prompt", "ambiguous"])
        ).rejects.toThrow("absolute");
    }
});

test("queue list creates no missing directory and provider/home isolation reaches the CLI", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "gt-queue-read-")), "absent");
    const program = new Command().exitOverride();
    let receipt: unknown;
    registerSessionQueueCommand({
        program,
        provider: "codex",
        output: (value) => {
            receipt = value;
        },
    });
    await program.parseAsync(
        ["queue", "list", "--session", "fixture", "--home", "/fixture/home", "--queue-root", root],
        { from: "user" }
    );
    expect(receipt).toMatchObject({ messages: [] });
    expect(existsSync(root)).toBe(false);

    await enqueueSessionMessage({
        target: { provider: "codex", sessionId: "fixture", sourceHome: "/fixture/home" },
        text: "isolated payload",
        root,
    });
    for (const [provider, home] of [
        ["claude", "/fixture/home"],
        ["grok", "/fixture/home"],
        ["codex", "/fixture/other"],
    ] as const) {
        const isolated = new Command().exitOverride();
        registerSessionQueueCommand({
            program: isolated,
            provider,
            output: (value) => {
                receipt = value;
            },
        });
        await isolated.parseAsync(["queue", "list", "--session", "fixture", "--home", home, "--queue-root", root], {
            from: "user",
        });
        expect(receipt).toMatchObject({ messages: [] });
    }
});

test("exact-session steer persists when unowned without starting, steering or pretending it was delivered", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-codex-queued-"));
    let nativeCalls = 0;
    const receipt = await steerCodexMessage({
        target: { provider: "codex", sessionId: "thread-1", sourceHome: "/fixture/codex" },
        text: "portable prompt",
        root,
        deps: {
            store: {
                listNames: () => ["thread-1"],
                readMeta: () => codexMessageFixture({ name: "thread-1", threadId: "other" }),
            },
            isLive: () => true,
            steer: async () => {
                nativeCalls++;
                throw new Error("Native primitive must not be reached");
            },
        },
    });
    expect(nativeCalls).toBe(0);
    expect(receipt).toMatchObject({ channel: "session-queue", delivered: false, queued: true });
    expect(listSessionMessages({ target: receipt.target, root })).toMatchObject([
        { text: "portable prompt", state: "queued" },
    ]);
});

test("exact-session steer checks source home and rejects ambiguous daemons before transport", async () => {
    const target = { provider: "codex" as const, sessionId: "thread-1", sourceHome: "/fixture/codex" };
    const root = mkdtempSync(join(tmpdir(), "gt-codex-identity-"));
    let nativeCalls = 0;
    const steer = async (): Promise<never> => {
        nativeCalls++;
        throw new Error("Native primitive must not be reached");
    };
    const receipt = await steerCodexMessage({
        target,
        text: "different home",
        root,
        deps: {
            store: { listNames: () => ["work"], readMeta: () => codexMessageFixture({ home: "/other/home" }) },
            isLive: () => true,
            steer,
        },
    });
    expect(receipt).toMatchObject({ delivered: false, queued: true });
    await expect(
        steerCodexMessage({
            target,
            text: "ambiguous",
            root,
            deps: {
                store: { listNames: () => ["one", "two"], readMeta: (name) => codexMessageFixture({ name }) },
                isLive: () => true,
                steer,
            },
        })
    ).rejects.toThrow("Multiple live");
    expect(nativeCalls).toBe(0);
});

test("a repeated delivery key that was queued while unowned is not steered once a daemon appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-codex-repeat-key-"));
    const target = { provider: "codex" as const, sessionId: "thread-1", sourceHome: "/fixture/codex" };
    let steered = 0;
    const steer = async (): Promise<never> => {
        steered++;
        throw new Error("A queued delivery must not be steered again");
    };
    const first = await steerCodexMessage({
        target,
        text: "keyed input",
        idempotencyKey: "fixture-key",
        root,
        deps: { store: { listNames: () => [], readMeta: () => null }, isLive: () => true, steer },
    });
    const repeat = await steerCodexMessage({
        target,
        text: "keyed input",
        idempotencyKey: "fixture-key",
        root,
        deps: {
            store: { listNames: () => ["work"], readMeta: () => codexMessageFixture() },
            isLive: () => true,
            steer,
        },
    });
    expect(repeat).toMatchObject({ channel: "session-queue", queued: true });
    expect(repeat.message?.id).toBe(first.message?.id);
    expect(steered).toBe(0);
});

test("daemon acceptance and boundary queue are not reported as consumer acknowledgement", async () => {
    for (const result of [{ turnId: "turn-1", queued: false }, { queued: true }]) {
        const receipt = await steerCodexMessage({
            target: { provider: "codex", sessionId: "thread-1", sourceHome: "/fixture/codex" },
            text: "native input",
            deps: {
                store: { listNames: () => ["work"], readMeta: () => codexMessageFixture() },
                isLive: () => true,
                steer: async (_meta, input) => {
                    expect(input.extras).toMatchObject({ expectSession: "thread-1", expectHome: "/fixture/codex" });
                    return { kind: "ack", result };
                },
                enqueue: async () => {
                    throw new Error("No fallback may be queued after a native attempt");
                },
            },
        });
        expect(receipt).toMatchObject({ channel: "codex", accepted: true, delivered: false, queued: result.queued });
    }
});

test("lost or malformed daemon receipt never creates an automatic second delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-codex-unknown-"));
    const target = { provider: "codex" as const, sessionId: "thread-1", sourceHome: "/fixture/codex" };
    for (const steer of [
        async (): Promise<never> => {
            throw new Error("Receipt lost after delivery");
        },
        async (): Promise<WorkerVerbOutcome> => ({ kind: "ack", result: {} }),
    ]) {
        await expect(
            steerCodexMessage({
                target,
                text: "uncertain prompt",
                root,
                deps: {
                    store: { listNames: () => ["work"], readMeta: () => codexMessageFixture() },
                    isLive: () => true,
                    steer,
                },
            })
        ).rejects.toThrow(CodexMessageUnknownError);
        expect(listSessionMessages({ target, root })).toEqual([]);
    }
});

test("Codex steer CLI retains --name and older prompt flags while allowing exact-session queues", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-codex-steer-cli-"));
    let receipt: unknown;
    let nativeCalls = 0;
    const program = new Command().exitOverride().option("-v, --verbose");
    program
        .command("steer")
        .requiredOption("--name <name>")
        .option("--prompt <text>")
        .option("--body <text>")
        .option("--force");
    registerCodexMessageCommands({
        program,
        output: (value) => {
            receipt = value;
        },
        deps: {
            store: { listNames: () => [], readMeta: () => codexMessageFixture() },
            steer: async (_meta, input) => {
                nativeCalls++;
                expect(input.prompt).toBe("legacy");
                return { kind: "ack", result: { turnId: "legacy-turn", queued: false } };
            },
        },
    });
    await program.parseAsync(["steer", "--name", "work", "--body", "legacy", "-v"], { from: "user" });
    expect(receipt).toEqual({ turnId: "legacy-turn", queued: false });
    expect(nativeCalls).toBe(1);

    const exact = new Command().exitOverride();
    exact.command("steer").requiredOption("--name <name>").option("--prompt <text>");
    registerCodexMessageCommands({
        program: exact,
        output: (value) => {
            receipt = value;
        },
        deps: { store: { listNames: () => [], readMeta: () => null } },
    });
    await exact.parseAsync(
        ["steer", "--session", "thread-1", "--home", "/fixture/codex", "--prompt", "queued", "--queue-root", root],
        { from: "user" }
    );
    expect(receipt).toMatchObject({ delivered: false, queued: true });
});

test("Codex driver rejects a reused name before the native control primitive and preserves normal delivery", async () => {
    const primitive = spyOn(controlChannel, "sendControlRequest");
    primitive.mockImplementation(async () => {
        throw new Error("Native primitive must not be reached");
    });
    try {
        await expect(
            Promise.resolve().then(() =>
                codexDriver.steer(codexMessageFixture({ threadId: "replacement" }), {
                    prompt: "guarded",
                    extras: { expectSession: "thread-1", expectHome: "/fixture/codex" },
                })
            )
        ).rejects.toThrow("no prompt was sent");
        await expect(
            Promise.resolve().then(() =>
                codexDriver.steer(codexMessageFixture({ home: "/other/home" }), {
                    prompt: "guarded",
                    extras: { expectSession: "thread-1", expectHome: "/fixture/codex" },
                })
            )
        ).rejects.toThrow("no prompt was sent");
        expect(primitive).not.toHaveBeenCalled();

        primitive.mockImplementation(async () => ({ ok: true, result: { turnId: "native-turn", queued: false } }));
        await codexDriver.steer(codexMessageFixture(), {
            prompt: "normal",
            extras: { expectSession: "thread-1", expectHome: "/fixture/codex" },
        });
        expect(primitive).toHaveBeenCalledWith("work", {
            op: "steer",
            body: "normal",
            force: false,
            expectedTarget: { threadId: "thread-1", home: "/fixture/codex" },
        });
    } finally {
        primitive.mockRestore();
    }
});

test("Codex driver refuses an unsupported turn guard and keeps a daemon-proven refusal typed", async () => {
    const primitive = spyOn(controlChannel, "sendControlRequest");
    primitive.mockImplementation(async () => {
        throw new Error("Native primitive must not be reached");
    });
    try {
        await expect(
            Promise.resolve().then(() =>
                codexDriver.steer(codexMessageFixture(), {
                    prompt: "guarded",
                    extras: { expectSession: "thread-1", expectHome: "/fixture/codex", expectTurn: "3" },
                })
            )
        ).rejects.toBeInstanceOf(WorkerDeliveryRejectedError);
        expect(primitive).not.toHaveBeenCalled();

        primitive.mockImplementation(async () => ({ ok: false, error: "thread changed", code: "rejected" }));
        await expect(
            codexDriver.steer(codexMessageFixture(), {
                prompt: "guarded",
                extras: { expectSession: "thread-1", expectHome: "/fixture/codex" },
            })
        ).rejects.toBeInstanceOf(WorkerDeliveryRejectedError);

        primitive.mockImplementation(async () => ({ ok: false, error: "daemon failed" }));
        const failure = await codexDriver
            .steer(codexMessageFixture(), {
                prompt: "guarded",
                extras: { expectSession: "thread-1", expectHome: "/fixture/codex" },
            })
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(WorkerDeliveryRejectedError);
    } finally {
        primitive.mockRestore();
    }
});

test("the wrapped named steer preserves structured pre-dispatch rejection receipts", async () => {
    const previousExitCode = process.exitCode;
    const program = new Command().exitOverride();
    program.command("steer").requiredOption("--name <name>").option("--prompt <text>").option("--json");
    let receipt: unknown;
    registerCodexMessageCommands({
        program,
        output: (value) => {
            receipt = value;
        },
        deps: {
            store: { listNames: () => ["work"], readMeta: () => codexMessageFixture() },
            steer: async () => {
                throw new WorkerDeliveryRejectedError("Identity changed; no prompt was sent.");
            },
        },
    });
    try {
        await program.parseAsync(["steer", "--name", "work", "--prompt", "guarded", "--json"], { from: "user" });
        expect(receipt).toMatchObject({ kind: "rejected", backend: "codex", name: "work" });
        expect(process.exitCode).toBe(1);
    } finally {
        process.exitCode = previousExitCode;
    }
});
