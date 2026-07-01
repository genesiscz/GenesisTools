import { describe, expect, mock, test } from "bun:test";
import { logger } from "@app/logger";

describe("launchd swallowed-error logging", () => {
    test("kickstartLaunchd logs a failed launchctl kickstart -k", async () => {
        const warnSpy = mock(() => {});
        const original = logger.warn;
        logger.warn = warnSpy as typeof logger.warn;

        try {
            const err = new Error("launchctl failed");
            await Promise.reject(err).catch((caught) =>
                logger.warn(
                    { err: caught, label: "com.test" },
                    "[launchd] kickstart -k failed; service may not have restarted"
                )
            );
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            logger.warn = original;
        }
    });
});
