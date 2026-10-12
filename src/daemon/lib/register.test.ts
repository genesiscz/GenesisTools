import { describe, expect, spyOn, test } from "bun:test";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";

setupStorageSandbox();

describe("daemon task registration retention default", () => {
    test("a task registered without explicit retention gets a sane default, not undefined", async () => {
        const { registerTask } = await import("./register");
        const { getTask } = await import("./config");

        await registerTask({ name: "test-task", command: "echo hi", every: "every 1 hour", overwrite: true });
        const task = await getTask("test-task");

        expect(task?.retention).toBeDefined();
        expect(task?.retention?.minRuns).toBeGreaterThanOrEqual(1);
        expect(task?.retention?.maxAgeDays).toBeGreaterThan(0);
    });
});

describe("isTaskRegistered", () => {
    test("only reads: it never creates the daemon's folders, so a status command stays read-only", async () => {
        const { isTaskRegistered } = await import("./register");
        const { Storage } = await import("@genesiscz/utils/storage");
        const ensureDirs = spyOn(Storage.prototype, "ensureDirs");

        try {
            expect(await isTaskRegistered("never-registered")).toBe(false);
            expect(ensureDirs).not.toHaveBeenCalled();
        } finally {
            ensureDirs.mockRestore();
        }
    });
});

describe("updateTask", () => {
    test("writes priority and missed-run policy, and null or the default value clears them", async () => {
        const { registerTask } = await import("./register");
        const { getTask, updateTask } = await import("./config");
        await registerTask({ name: "nightly", command: "true", every: "every day at 03:00", overwrite: true });

        await updateTask("nightly", { priority: "low", missedRun: { mode: "retry-at", times: [" 10:00", "12:00"] } });
        expect(await getTask("nightly")).toMatchObject({
            priority: "low",
            missedRun: { mode: "retry-at", times: ["10:00", "12:00"] },
        });

        await updateTask("nightly", { priority: "normal", missedRun: { mode: "asap" }, timeoutMs: 60_000 });
        const cleared = await getTask("nightly");
        expect(cleared?.priority).toBeUndefined();
        expect(cleared?.missedRun).toBeUndefined();
        expect(cleared?.timeoutMs).toBe(60_000);
    });

    test("rejects an invalid field and writes nothing", async () => {
        const { registerTask } = await import("./register");
        const { getTask, updateTask } = await import("./config");
        await registerTask({ name: "hourly", command: "true", every: "every 1 hour", overwrite: true });

        await expect(updateTask("hourly", { every: "sometimes", priority: "low" })).rejects.toThrow(/Invalid interval/);
        await expect(updateTask("hourly", { missedRun: { mode: "retry-at", times: ["25:00"] } })).rejects.toThrow(
            /HH:MM/
        );
        await expect(updateTask("hourly", { missedRun: { mode: "retry-at" } })).rejects.toThrow(/at least one time/);
        await expect(updateTask("missing", { priority: "low" })).rejects.toThrow(/not found/);
        expect((await getTask("hourly"))?.priority).toBeUndefined();
    });
});
