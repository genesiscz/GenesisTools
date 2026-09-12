import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInterval } from "@app/daemon/lib/interval";
import type { RegisterTaskOptions } from "@app/daemon/lib/register";
import {
    type DaemonRegistry,
    LEGACY_USAGE_TASK_NAME,
    registerUsagePollTask,
    USAGE_TASK_NAME,
    validateRetentionDays,
    validateRetentionMin,
} from "./daemon";

/** A fake registry: no launchd, no `~/.genesis-tools/daemon` write, no real task. */
function fakeRegistry(registered: string[]): {
    registry: DaemonRegistry;
    registeredWith: RegisterTaskOptions[];
    unregistered: string[];
} {
    const known = new Set(registered);
    const registeredWith: RegisterTaskOptions[] = [];
    const unregistered: string[] = [];

    return {
        registeredWith,
        unregistered,
        registry: {
            isTaskRegistered: async (name: string) => known.has(name),
            unregisterTask: async (name: string) => {
                unregistered.push(name);
                return known.delete(name);
            },
            // Mirrors the real `registerTask`: with `overwrite: true` it answers `true`
            // for an update as well as for a create, and it validates the interval first.
            registerTask: async (opts: RegisterTaskOptions) => {
                parseInterval(opts.every);
                registeredWith.push(opts);

                if (known.has(opts.name) && !opts.overwrite) {
                    return false;
                }

                known.add(opts.name);
                return true;
            },
        },
    };
}

const ARGS = { interval: "every 30 seconds", maxAgeDays: 3, minRuns: 100, script: "/tmp/poll-daemon.ts" };

describe("usage daemon retention CLI validation", () => {
    test("rejects --retention-min 0", () => {
        expect(validateRetentionMin("0")).toBeNull();
    });

    test("accepts --retention-min 1", () => {
        expect(validateRetentionMin("1")).toBe(1);
    });

    test("rejects a negative --retention-days", () => {
        expect(validateRetentionDays("-1")).toBeNull();
        expect(validateRetentionDays("0")).toBe(0);
    });
});

describe("registerUsagePollTask", () => {
    test("registers the one all-provider task", async () => {
        const { registry, registeredWith, unregistered } = fakeRegistry([]);

        const result = await registerUsagePollTask({ ...ARGS, registry });

        expect(result).toEqual({ created: true, migratedFromLegacy: false });
        expect(unregistered).toEqual([]);
        expect(registeredWith).toHaveLength(1);
        expect(registeredWith[0]).toMatchObject({
            name: USAGE_TASK_NAME,
            every: "every 30 seconds",
            overwrite: true,
            notify: false,
            retention: { maxAgeDays: 3, minRuns: 100 },
        });
        expect(registeredWith[0].command).toContain("/tmp/poll-daemon.ts");
    });

    // D11: the migration itself. Both tasks registered would poll every anthropic
    // account twice a minute and write two payload shapes to one cache key.
    test("removes the old claude-usage-poll task BEFORE registering the new one", async () => {
        const { registry, registeredWith, unregistered } = fakeRegistry([LEGACY_USAGE_TASK_NAME]);

        const result = await registerUsagePollTask({ ...ARGS, registry });

        expect(result.migratedFromLegacy).toBe(true);
        expect(unregistered).toEqual([LEGACY_USAGE_TASK_NAME]);
        expect(registeredWith[0].name).toBe(USAGE_TASK_NAME);
    });

    // Negative control: an ordinary re-register must not touch a task that is not there.
    test("does not unregister anything when only the new task exists", async () => {
        const { registry, unregistered } = fakeRegistry([USAGE_TASK_NAME]);

        const result = await registerUsagePollTask({ ...ARGS, registry });

        expect(result).toEqual({ created: false, migratedFromLegacy: false });
        expect(unregistered).toEqual([]);
    });
    // The interval reaches `parseInterval` inside `registerTask`, i.e. AFTER the legacy
    // task is gone. Validating first is what keeps a typo from leaving no task at all.
    test("rejects an invalid interval without removing the legacy task", async () => {
        const { registry, registeredWith, unregistered } = fakeRegistry([LEGACY_USAGE_TASK_NAME]);

        await expect(registerUsagePollTask({ ...ARGS, interval: "every fortnight", registry })).rejects.toThrow(
            /Invalid interval/
        );
        expect(unregistered).toEqual([]);
        expect(registeredWith).toEqual([]);
    });

    // Negative control: a valid interval still migrates and registers.
    test("a valid interval still removes the legacy task and registers", async () => {
        const { registry, registeredWith, unregistered } = fakeRegistry([LEGACY_USAGE_TASK_NAME]);

        const result = await registerUsagePollTask({ ...ARGS, registry });

        expect(result).toEqual({ created: true, migratedFromLegacy: true });
        expect(unregistered).toEqual([LEGACY_USAGE_TASK_NAME]);
        expect(registeredWith).toHaveLength(1);
    });

    // `overwrite: true` makes the real `registerTask` answer `true` either way, so
    // "Updated task" can only come from asking whether the task was there first.
    test("reports an overwrite as an update, not as a creation", async () => {
        const { registry, registeredWith } = fakeRegistry([USAGE_TASK_NAME]);

        const result = await registerUsagePollTask({ ...ARGS, registry });

        expect(result.created).toBe(false);
        expect(registeredWith[0].overwrite).toBe(true);
    });
});

/**
 * PR #368 review t5. The daemon runs a registered command as `sh -c <command>`
 * (`src/daemon/lib/runner.ts`), so interpolating the Bun path and the poll script
 * into it unquoted meant a checkout or a Bun install under a directory containing
 * a space registered successfully and then failed on every single poll.
 *
 * The proof is the argv a REAL `sh` derives from the registered string, not the
 * string itself: a string comparison would only restate the implementation.
 */
describe("the registered command survives paths with spaces", () => {
    /** What `sh -c` makes of the registered command, without running bun. */
    async function argvFrom(command: string): Promise<string[]> {
        const proc = Bun.spawn(["sh", "-c", `printf '%s\\n' ${command}`], {
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        // `printf '%s\n'` writes a trailing newline per argument, so only the last
        // split element is dropped.
        return stdout.split("\n").slice(0, -1);
    }

    test("a script path with a space stays one argument", async () => {
        const { registry, registeredWith } = fakeRegistry([]);
        const script = "/Users/dev/My Projects/GenesisTools/poll-daemon.ts";

        await registerUsagePollTask({ ...ARGS, script, registry });

        const argv = await argvFrom(registeredWith[0].command);
        expect(argv.at(-1)).toBe(script);
        expect(argv.at(-2)).toBe("run");
    });

    test("a script path holding shell metacharacters is not interpreted", async () => {
        const { registry, registeredWith } = fakeRegistry([]);
        const script = "/tmp/a b/$HOME;`whoami`/poll-daemon.ts";

        await registerUsagePollTask({ ...ARGS, script, registry });

        expect((await argvFrom(registeredWith[0].command)).at(-1)).toBe(script);
    });

    // NEGATIVE CONTROL: the command still RUNS. Quoting that broke the invocation
    // would pass every assertion above while polling nothing.
    test("the registered command actually executes the script", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "gt-usage-daemon-")), "my scripts");
        mkdirSync(dir, { recursive: true });
        const script = join(dir, "poll-daemon.ts");
        writeFileSync(script, 'console.log("POLLED-OK");\n');

        const { registry, registeredWith } = fakeRegistry([]);
        await registerUsagePollTask({ ...ARGS, script, registry });

        const proc = Bun.spawn(["sh", "-c", registeredWith[0].command], {
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const stdout = await new Response(proc.stdout).text();

        expect(await proc.exited).toBe(0);
        expect(stdout).toContain("POLLED-OK");
    }, 30_000);
});
