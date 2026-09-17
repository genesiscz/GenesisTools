import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    clearPendingLogin,
    clearStalePendingLogin,
    pendingLoginPath,
    readPendingLogin,
    writePendingLogin,
} from "./login-state.ts";

const SERVER = "wisprflow";

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-mcp-login-state-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
});

afterEach(() => {
    clearPendingLogin(SERVER);
    env.testing.unset("GENESIS_TOOLS_HOME");
    rmSync(home, { recursive: true, force: true });
});

describe("pending-login records", () => {
    test("a record written by a live process reads back with a PidRecord identity", () => {
        writePendingLogin({
            server: SERVER,
            pid: process.pid,
            url: "https://issuer.example/authorize?state=x",
        });

        const pending = readPendingLogin(SERVER);
        expect(pending).toMatchObject({
            server: SERVER,
            url: "https://issuer.example/authorize?state=x",
        });
        expect(pending?.identity.pid).toBe(process.pid);
        expect(typeof pending?.identity.command).toBe("string");
        expect(pending?.identity.startedAt).not.toBeNull();
        expect(pending?.identity.writtenAt).toBeGreaterThan(0);
        expect(existsSync(pendingLoginPath(SERVER))).toBe(true);
    });

    test("no file means no pending login", () => {
        expect(readPendingLogin(SERVER)).toBeUndefined();
    });

    test("a record whose process is dead is stale; read does not delete it", () => {
        writePendingLogin({ server: SERVER, pid: 2_147_483_000 });

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(existsSync(pendingLoginPath(SERVER))).toBe(true);
        expect(clearStalePendingLogin(SERVER)).toBe(true);
        expect(existsSync(pendingLoginPath(SERVER))).toBe(false);
    });

    test("a live pid holding a different command is foreign; read does not delete it", () => {
        writePendingLogin({ server: SERVER, pid: process.pid });
        const path = pendingLoginPath(SERVER);
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Record<string, unknown>;
        writeFileSync(path, SafeJSON.stringify({ ...raw, command: "some-other-program --not-a-login" }));

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(existsSync(path)).toBe(true);
        expect(clearStalePendingLogin(SERVER)).toBe(true);
        expect(existsSync(path)).toBe(false);
    });

    test("a matching command with a drifted process start time is foreign", () => {
        writePendingLogin({ server: SERVER, pid: process.pid });
        const path = pendingLoginPath(SERVER);
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Record<string, unknown>;
        const startedAt = typeof raw.startedAt === "number" ? raw.startedAt : Date.now();
        writeFileSync(path, SafeJSON.stringify({ ...raw, startedAt: startedAt - 600_000 }));

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(clearStalePendingLogin(SERVER)).toBe(true);
        expect(existsSync(path)).toBe(false);
    });

    test("an unreadable record is not trusted and is not deleted by read", () => {
        writePendingLogin({ server: SERVER, pid: process.pid });
        writeFileSync(pendingLoginPath(SERVER), "{ not json");

        expect(readPendingLogin(SERVER)).toBeUndefined();
        expect(existsSync(pendingLoginPath(SERVER))).toBe(true);
        expect(clearStalePendingLogin(SERVER)).toBe(true);
        expect(existsSync(pendingLoginPath(SERVER))).toBe(false);
    });

    test("a record for a different server name is not returned for this one", () => {
        writePendingLogin({ server: SERVER, pid: process.pid });
        writeFileSync(
            pendingLoginPath(SERVER),
            SafeJSON.stringify({
                server: "rohlik",
                pid: process.pid,
                command: null,
                startedAt: null,
                writtenAt: 1,
            })
        );

        expect(readPendingLogin(SERVER)).toBeUndefined();
    });

    test("clear is safe when nothing is pending", () => {
        expect(() => clearPendingLogin(SERVER)).not.toThrow();
        expect(clearStalePendingLogin(SERVER)).toBe(false);
    });

    test("a URL-less write keeps a same-pid URL the child already stored", () => {
        writePendingLogin({
            server: SERVER,
            pid: process.pid,
            url: "https://issuer.example/authorize",
            userCode: "ABCD-EFGH",
        });
        writePendingLogin({ server: SERVER, pid: process.pid });

        expect(readPendingLogin(SERVER)).toMatchObject({
            server: SERVER,
            url: "https://issuer.example/authorize",
            userCode: "ABCD-EFGH",
        });
    });

    test("clear with an owner pid leaves a record owned by someone else", () => {
        writePendingLogin({ server: SERVER, pid: process.pid, url: "https://issuer.example/authorize" });

        clearPendingLogin(SERVER, process.pid + 1);
        expect(existsSync(pendingLoginPath(SERVER))).toBe(true);

        clearPendingLogin(SERVER, process.pid);
        expect(existsSync(pendingLoginPath(SERVER))).toBe(false);
    });

    test("clearStale does not delete a live record that replaced a stale snapshot", () => {
        writePendingLogin({ server: SERVER, pid: 2_147_483_000 });
        writePendingLogin({ server: SERVER, pid: process.pid, url: "https://issuer.example/authorize" });

        expect(clearStalePendingLogin(SERVER)).toBe(false);
        expect(readPendingLogin(SERVER)?.url).toBe("https://issuer.example/authorize");
    });
});
