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

function fakeDriver(options: { backend?: WorkerBackend; daemon?: boolean; promptOptional?: boolean } = {}): {
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
            return { running: true, pids: [4242] };
        },
        async interruptTurn(meta) {
            calls.interrupt.push(meta.name);
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
        readDefaultLabel: "the fixture transcript",
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
