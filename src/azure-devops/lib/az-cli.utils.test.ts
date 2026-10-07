import { describe, expect, test } from "bun:test";
import { isAzOnPath } from "@app/azure-devops/lib/az-cli.utils";

describe("isAzOnPath", () => {
    test("false when az does not resolve, so callers do not report a missing CLI as a failed login", () => {
        expect(isAzOnPath(() => null)).toBe(false);
    });

    test("true when az resolves", () => {
        expect(isAzOnPath(() => "/usr/bin/az")).toBe(true);
    });
});
