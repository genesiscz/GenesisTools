import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { clearPendingLogin, pendingLoginPath, readPendingLogin, writePendingLogin } from "./login-state.ts";

const SERVER = "wisprflow";

afterEach(() => {
    clearPendingLogin(SERVER);
});

describe("pending-login records", () => {
    test("a record written by a live process reads back whole", () => {
        writePendingLogin({
            server: SERVER,
            pid: process.pid,
            url: "https://issuer.example/authorize?state=x",
            startedAt: 1_000,
        });

        const pending = readPendingLogin(SERVER);
        expect(pending).toMatchObject({
            server: SERVER,
            pid: process.pid,
            url: "https://issuer.example/authorize?state=x",
            startedAt: 1_000,
        });
        expect(typeof pending?.command).toBe("string");
    });

    test("no file means no pending login", () => {
        expect(readPendingLogin(SERVER)).toBeUndefined();
    });

    test("a record whose process is dead is stale and gets removed", () => {
        // pid 1 belongs to launchd and answers EPERM, so the check reads "not ours", and
        // a pid this large is never allocated on macOS, so it reads "gone" as well.
        writePendingLogin({ server: SERVER, pid: 2_147_483_000, startedAt: 1_000 });

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(existsSync(pendingLoginPath(SERVER))).toBe(false);
    });

    test("an unreadable record is removed rather than trusted", () => {
        writePendingLogin({ server: SERVER, pid: process.pid, startedAt: 1_000 });
        writeFileSync(pendingLoginPath(SERVER), "{ not json");

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(existsSync(pendingLoginPath(SERVER))).toBe(false);
    });

    test("a record for a different server name is not returned for this one", () => {
        writePendingLogin({ server: SERVER, pid: process.pid, startedAt: 1_000 });
        writeFileSync(
            pendingLoginPath(SERVER),
            SafeJSON.stringify({ server: "rohlik", pid: process.pid, startedAt: 1_000 })
        );

        expect(readPendingLogin(SERVER)).toBeUndefined();
    });

    test("clear is safe when nothing is pending", () => {
        expect(() => clearPendingLogin(SERVER)).not.toThrow();
    });
});
