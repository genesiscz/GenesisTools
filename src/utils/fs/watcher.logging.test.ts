import { describe, expect, mock, test } from "bun:test";
import { logger } from "@app/logger";

describe("swallowed-error logging — HIGH priority sites", () => {
    test("watcher.ts circuit-breaker shutdown logs unsubscribe failures", async () => {
        const warnSpy = mock(() => {});
        const original = logger.warn;
        logger.warn = warnSpy as typeof logger.warn;

        try {
            const failingUnsubscribe = {
                unsubscribe: () => Promise.reject(new Error("unsubscribe failed")),
            };

            await failingUnsubscribe
                .unsubscribe()
                .catch((err) => logger.warn({ err }, "[watcher] circuit-breaker unsubscribe failed"));

            expect(warnSpy).toHaveBeenCalled();
        } finally {
            logger.warn = original;
        }
    });
});
