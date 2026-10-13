import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@genesiscz/utils/logger";
import type { DaemonTask } from "./types";

describe("loadConfig every-field validation", () => {
    test("warns and filters out a task with a malformed every field", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const { validateTasks } = await import("./config");

            const tasks: DaemonTask[] = [
                {
                    name: "bad-task",
                    command: "echo hi",
                    every: "not-a-valid-interval",
                    retries: 0,
                    enabled: true,
                },
            ];

            const filtered = validateTasks(tasks);

            expect(warnSpy).toHaveBeenCalled();
            expect(filtered).toEqual([]);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe("loadConfig task-name validation", () => {
    test("drops a hand-edited name that registerTask would refuse, so two tasks cannot share one log folder", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const { validateTasks } = await import("./config");
            const task = (name: string): DaemonTask => ({
                name,
                command: "echo hi",
                every: "every 1 hour",
                retries: 0,
                enabled: true,
            });

            const kept = validateTasks([task("sync/mail"), task("sync_mail"), task("up..dir"), task("plain")]);

            expect(kept.map((entry) => entry.name)).toEqual(["sync_mail", "plain"]);
            expect(warnSpy).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
