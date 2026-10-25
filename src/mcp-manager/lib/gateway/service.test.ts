import { describe, expect, test } from "bun:test";
import { takeDetachedMarker } from "@genesiscz/utils/cli/detached";
import { gatewayServiceEnv } from "./service.ts";

describe("gateway launchd agent", () => {
    // launchd is the `tools` wrapper's parent (ppid 1), so without the marker the wrapper's orphan
    // watchdog stopped the gateway ~2 s after it started listening (#565).
    test("its environment marks the run detached, so the wrapper skips the orphan watchdog", () => {
        expect(takeDetachedMarker({ ...gatewayServiceEnv() })).toBe(true);
    });
});
