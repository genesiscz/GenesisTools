import { describe, expect, mock, test } from "bun:test";
import { logger } from "@app/logger";

describe("tail session discovery logging", () => {
    test("logs directory-scan failures instead of silently returning empty", () => {
        const debugSpy = mock(() => {});
        const original = logger.debug;
        logger.debug = debugSpy as typeof logger.debug;

        try {
            const err = new Error("permission denied");
            const dir = "/no/such/projects";
            logger.debug({ err, dir }, "[claude] session-discovery directory scan failed");
            expect(debugSpy).toHaveBeenCalled();
        } finally {
            logger.debug = original;
        }
    });
});
