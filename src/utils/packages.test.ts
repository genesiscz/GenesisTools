import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { ensurePackages } from "./packages";

const MISSING = "__genesis_tools_missing_pkg_for_ensure_packages_test__";

function fakeAddProc(): ReturnType<typeof Bun.spawn> {
    const stderr = new ReadableStream({
        start(controller) {
            controller.close();
        },
    });

    return {
        exited: Promise.resolve(0),
        stderr,
    } as unknown as ReturnType<typeof Bun.spawn>;
}

function isBunAdd(cmd: unknown): boolean {
    return Array.isArray(cmd) && cmd[0] === "bun" && cmd[1] === "add";
}

describe("ensurePackages", () => {
    afterEach(() => {
        mock.restore();
    });

    test("NODE_ENV=test does not spawn bun add", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation((cmd) => {
            if (isBunAdd(cmd)) {
                throw new Error("bun add must not run under NODE_ENV=test");
            }

            return fakeAddProc();
        });

        await env.testing.withOverrides({ NODE_ENV: "test" }, async () => {
            await ensurePackages([MISSING], { silent: true });
        });

        expect(spawn.mock.calls.some((call) => isBunAdd(call[0]))).toBe(false);
    });

    test("a non-test env still reaches bun add", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation((cmd) => {
            if (isBunAdd(cmd)) {
                return fakeAddProc();
            }

            throw new Error(`unexpected spawn: ${String(cmd)}`);
        });

        await env.testing.withOverrides({ NODE_ENV: "development" }, async () => {
            await ensurePackages([MISSING], { silent: true });
        });

        expect(spawn.mock.calls.some((call) => isBunAdd(call[0]))).toBe(true);
    });
});
