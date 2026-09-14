import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import type { WorkerDriver, WorkerMeta } from "@genesiscz/utils/worker/driver";
import { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
import { Command } from "commander";
import { registerWorkerVerbs } from "./worker";

/**
 * The regression guard the parity campaign exists for: one intent must produce the same SHAPE
 * of answer on every coding-agent tool. Before this factory the prompt flags were `--prompt` on
 * two backends and `--body` on the third, `sessions --json` existed on one of three, and `stop`
 * meant "kill the turn" on two and "tear the daemon down" on the third with no way to ask for
 * the other one.
 */

interface Calls {
    spawn: unknown[];
    steer: unknown[];
    interrupt: string[];
    shutdown: string[];
}

/** Everything the command writes to stderr, where every human status line lands. */
async function captureStderr(run: () => Promise<unknown>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        const done = rest.find((argument) => typeof argument === "function");

        if (typeof done === "function") {
            done();
        }

        return true;
    }) as typeof process.stderr.write;

    try {
        await run();
    } finally {
        process.stderr.write = original;
    }

    return chunks.join("");
}

function fakeDriver(
    options: {
        backend?: WorkerBackend;
        daemon?: boolean;
        promptOptional?: boolean;
        running?: boolean;
        /** What `interruptTurn` reports it actually signalled; omitted means it reports nothing. */
        signalled?: number[];
    } = {}
): {
    driver: WorkerDriver<WorkerMeta>;
    calls: Calls;
    dir: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "worker-verbs-"));
    const calls: Calls = { spawn: [], steer: [], interrupt: [], shutdown: [] };
    const store = new WorkerMetaStore<WorkerMeta>({
        dir: () => dir,
        metaPath: (name) => join(dir, `${name}.meta.json`),
        firstInvalidField: () => null,
        label: "fixture session",
        title: "Fixture session",
        existsMessage: (name) => `Fixture session '${name}' already exists.`,
        log: logger.child({ component: "worker-verbs:test" }),
    });

    const driver: WorkerDriver<WorkerMeta> = {
        backend: options.backend ?? "grok",
        store,
        help: {
            spawn: "a fixture session",
            steer: "Steer the fixture",
            read: "the fixture transcript",
            tail: "Follow the fixture",
        },
        ...(options.promptOptional ? { spawnFlags: { promptOptional: true } } : {}),
        legacyPromptFlags: { text: "body", file: "bodyFile" },
        extendSteer(command) {
            command.addOption(command.createOption("--body <text>", "older spelling").hideHelp());
        },
        async spawn(input) {
            calls.spawn.push(input);
            return { kind: "ack", result: { spawned: input.name } };
        },
        async steer(meta, input) {
            calls.steer.push({ name: meta.name, prompt: input.prompt });
            return { kind: "ack", result: { steered: meta.name } };
        },
        async liveness() {
            return { running: options.running ?? true, pids: [4242] };
        },
        async interruptTurn(meta) {
            calls.interrupt.push(meta.name);

            return options.signalled === undefined ? undefined : { kind: "signalled", pids: options.signalled };
        },
        ...(options.daemon
            ? {
                  async shutdown(meta: WorkerMeta) {
                      calls.shutdown.push(meta.name);
                  },
              }
            : {}),
        async readDefault() {
            return Promise.resolve();
        },

        rowHeaders: ["NAME"],
        row: (meta) => [meta.name],
    };

    return { driver, calls, dir };
}

function programFor(driver: WorkerDriver<WorkerMeta>): Command {
    const program = new Command();
    program.exitOverride();
    registerWorkerVerbs(program, driver, { tool: "tools fixture", subcommand: [] });

    return program;
}

test("a brief reaches spawn from --prompt and from --prompt-file, and both together is refused", async () => {
    const { driver, calls, dir } = fakeDriver();
    const program = programFor(driver);

    await program.parseAsync(["spawn", "--name", "one", "--prompt", "inline brief"], { from: "user" });
    expect(calls.spawn).toEqual([expect.objectContaining({ name: "one", prompt: "inline brief" })]);

    const file = join(dir, "brief.md");
    writeFileSync(file, "brief from a file");
    await programFor(driver).parseAsync(["spawn", "--name", "two", "--prompt-file", file], { from: "user" });
    expect(calls.spawn.at(-1)).toEqual(expect.objectContaining({ name: "two", prompt: "brief from a file" }));

    await expect(
        programFor(driver).parseAsync(["spawn", "--name", "three", "--prompt", "a", "--prompt-file", file], {
            from: "user",
        })
    ).rejects.toThrow(/mutually exclusive/);
});

test("a missing brief is refused, unless the backend declared the prompt optional", async () => {
    const bare = fakeDriver();
    await expect(programFor(bare.driver).parseAsync(["spawn", "--name", "one"], { from: "user" })).rejects.toThrow(
        /brief is required/
    );

    const daemon = fakeDriver({ promptOptional: true });
    await programFor(daemon.driver).parseAsync(["spawn", "--name", "one"], { from: "user" });
    expect(daemon.calls.spawn).toHaveLength(1);
    expect(daemon.calls.spawn[0]).toMatchObject({ name: "one" });
    expect((daemon.calls.spawn[0] as { prompt?: string }).prompt).toBeUndefined();
});

test("steer takes --prompt, and still answers to the older spelling the backend declared", async () => {
    const { driver, calls } = fakeDriver();
    driver.store.createMeta({ name: "live", cwd: "/tmp/fixture" });

    await programFor(driver).parseAsync(["steer", "--name", "live", "--prompt", "carry on"], { from: "user" });
    await programFor(driver).parseAsync(["steer", "--name", "live", "--body", "older spelling"], { from: "user" });

    expect(calls.steer).toEqual([
        { name: "live", prompt: "carry on" },
        { name: "live", prompt: "older spelling" },
    ]);
});

test("a verb naming a session that does not exist says so, and names how to list them", async () => {
    const { driver } = fakeDriver();

    await expect(
        programFor(driver).parseAsync(["steer", "--name", "ghost", "--prompt", "x"], { from: "user" })
    ).rejects.toThrow(/Fixture session not found: ghost\. List them with: tools fixture sessions/);
});

test("stop ends the turn where there is no daemon, and tears the daemon down where there is one", async () => {
    const spawned = fakeDriver();
    spawned.driver.store.createMeta({ name: "live", cwd: "/tmp/fixture" });
    await programFor(spawned.driver).parseAsync(["stop", "--name", "live"], { from: "user" });
    expect(spawned.calls).toMatchObject({ interrupt: ["live"], shutdown: [] });

    // The same word on a daemon backend means the session, not the turn — and `interrupt` is
    // what reaches the turn. Both verbs exist everywhere so a caller never has to know which.
    const daemon = fakeDriver({ backend: "codex", daemon: true });
    daemon.driver.store.createMeta({ name: "live", cwd: "/tmp/fixture" });
    await programFor(daemon.driver).parseAsync(["stop", "--name", "live"], { from: "user" });
    await programFor(daemon.driver).parseAsync(["interrupt", "--name", "live"], { from: "user" });
    expect(daemon.calls).toMatchObject({ shutdown: ["live"], interrupt: ["live"] });
});

test("a daemon backend still interrupts a turn its liveness calls dead, which is the turn worth interrupting", async () => {
    // Codex derives `running` from the meta file and reports `stalled` after 120s with no
    // notification. That IS the hung turn a user wants to interrupt, and refusing left `stop`
    // — which tears the daemon down and loses the session — as the only way out.
    const daemon = fakeDriver({ backend: "codex", daemon: true, running: false });
    daemon.driver.store.createMeta({ name: "hung", cwd: "/tmp/fixture" });
    await programFor(daemon.driver).parseAsync(["interrupt", "--name", "hung"], { from: "user" });

    expect(daemon.calls.interrupt).toEqual(["hung"]);
});

test("NEGATIVE CONTROL: a backend whose turn IS the process still refuses when nothing is running", async () => {
    // Without a daemon there is genuinely nothing to talk to, so the refusal must survive.
    const plain = fakeDriver({ running: false });
    plain.driver.store.createMeta({ name: "idle", cwd: "/tmp/fixture" });
    await programFor(plain.driver).parseAsync(["interrupt", "--name", "idle"], { from: "user" });

    expect(plain.calls.interrupt).toEqual([]);
});

test("interrupt reports what was actually signalled, not what liveness saw a moment earlier", async () => {
    // `liveness()` and `interruptTurn()` each read the process table. A turn that ends between
    // the two signals nothing, and the confirmation sentence still claimed it had been stopped.
    const ended = fakeDriver({ signalled: [] });
    ended.driver.store.createMeta({ name: "ghosted", cwd: "/tmp/fixture" });

    const missed = await captureStderr(() =>
        programFor(ended.driver).parseAsync(["interrupt", "--name", "ghosted"], { from: "user" })
    );
    expect(missed).toMatch(/already ended/);
    expect(missed).not.toMatch(/Stopped the running turn/);

    // NEGATIVE CONTROL: a turn that really took the signal still gets the confirmation.
    const killed = fakeDriver({ signalled: [4242] });
    killed.driver.store.createMeta({ name: "live", cwd: "/tmp/fixture" });

    const stopped = await captureStderr(() =>
        programFor(killed.driver).parseAsync(["interrupt", "--name", "live"], { from: "user" })
    );
    expect(stopped).toMatch(/Stopped the running turn of 'live'/);
});

test("a backend that cannot pin an account does not advertise --account", () => {
    // The flag can only throw on grok, so offering it in `--help` is a promise the tool cannot
    // keep: the user learns it is unsupported by trying it. It stays registered but hidden, so
    // the refusal that explains what to do instead still fires instead of "unknown option".
    const grok = programFor(fakeDriver({ backend: "grok" }).driver);
    const grokSpawn = grok.commands.find((command) => command.name() === "spawn");

    expect(grokSpawn?.options.filter((option) => !option.hidden).map((option) => option.long)).not.toContain(
        "--account"
    );
    expect(grokSpawn?.options.map((option) => option.long)).toContain("--account");

    // NEGATIVE CONTROL: a backend that does pin an account still advertises it.
    const codex = programFor(fakeDriver({ backend: "codex" }).driver);
    const codexSpawn = codex.commands.find((command) => command.name() === "spawn");

    expect(codexSpawn?.options.filter((option) => !option.hidden).map((option) => option.long)).toContain("--account");
});

test("every backend gets sessions --json and a --name-less status", () => {
    const { driver } = fakeDriver();
    const program = programFor(driver);
    const names = program.commands.map((command) => command.name());

    expect(names).toEqual(
        expect.arrayContaining(["spawn", "steer", "read", "tail", "status", "sessions", "stop", "interrupt"])
    );
    expect(program.commands.find((c) => c.name() === "sessions")?.options.map((o) => o.long)).toContain("--json");

    const status = program.commands.find((command) => command.name() === "status");
    expect(status?.options.map((option) => option.long)).toEqual(expect.arrayContaining(["--name", "--json"]));
    // Listing every session is what a bare `status` does; it must not be a parse error.
    // `mandatory` is the flag itself; `required` would only say its VALUE is not optional.
    expect(status?.options.find((option) => option.long === "--name")?.mandatory).toBe(false);
});
