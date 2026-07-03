import { afterEach, describe, expect, mock, test } from "bun:test";
import { logger } from "@app/logger";
import { _setGetProjectDirsTestHooks, getProjectDirs } from "./tail";

describe("tail session discovery logging", () => {
    afterEach(() => {
        _setGetProjectDirsTestHooks(undefined);
    });

    test("logs directory-scan failures instead of silently returning empty", () => {
        const debugSpy = mock((..._args: unknown[]) => {});
        const original = logger.debug;
        logger.debug = debugSpy as typeof logger.debug;

        _setGetProjectDirsTestHooks({
            existsSync: () => true,
            readdirSync: () => {
                throw new Error("permission denied");
            },
        });

        try {
            const dirs = getProjectDirs();

            expect(dirs).toEqual([]);
            expect(debugSpy).toHaveBeenCalled();

            const [payload] = debugSpy.mock.calls[0] ?? [];
            expect((payload as { dir?: string }).dir).toBeDefined();
        } finally {
            logger.debug = original;
        }
    });
});
