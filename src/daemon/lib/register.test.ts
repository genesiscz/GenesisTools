import { describe, expect, test } from "bun:test";
import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

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
