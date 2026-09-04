import { describe, expect, test } from "bun:test";
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
            registerTask: async (opts: RegisterTaskOptions) => {
                registeredWith.push(opts);
                const created = !known.has(opts.name);
                known.add(opts.name);
                return created;
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
});
