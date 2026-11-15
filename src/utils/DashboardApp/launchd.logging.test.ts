import { describe, expect, mock, test } from "bun:test";
import { logger } from "@genesiscz/utils/logger";
import { kickstartLaunchd } from "@genesiscz/utils/process/launchd-agent";

describe("launchd swallowed-error logging", () => {
    test("kickstartLaunchd logs a failed launchctl kickstart -k", async () => {
        if (process.platform !== "darwin") {
            return;
        }

        const warnSpy = mock((..._args: unknown[]) => {});
        const original = logger.warn;
        logger.warn = warnSpy as typeof logger.warn;

        try {
            // No launchd service exists under this label, so the real `launchctl
            // kickstart -k` invocation genuinely fails — exercising the catch path
            // instead of simulating it inline.
            expect(await kickstartLaunchd("com.genesis-tools.test.nonexistent-service")).toBe(false);

            expect(warnSpy).toHaveBeenCalled();
            const [payload] = warnSpy.mock.calls[0] ?? [];
            expect((payload as { label?: string }).label).toBe("com.genesis-tools.test.nonexistent-service");
        } finally {
            logger.warn = original;
        }
    });
});
