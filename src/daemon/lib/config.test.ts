import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@app/logger";
import type { DaemonTask } from "./types";

describe("loadConfig every-field validation", () => {
    test("warns when a task has a malformed every field", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        const { validateTaskIntervals } = await import("./config");

        const tasks: DaemonTask[] = [
            {
                name: "bad-task",
                command: "echo hi",
                every: "not-a-valid-interval",
                retries: 0,
                enabled: true,
            },
        ];

        validateTaskIntervals(tasks);

        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
