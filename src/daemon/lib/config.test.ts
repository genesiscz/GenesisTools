import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@app/logger";
import type { DaemonTask } from "./types";

describe("loadConfig every-field validation", () => {
    test("warns and filters out a task with a malformed every field", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

        try {
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

            const filtered = validateTaskIntervals(tasks);

            expect(warnSpy).toHaveBeenCalled();
            expect(filtered).toEqual([]);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
