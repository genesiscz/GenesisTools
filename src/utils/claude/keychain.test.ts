import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    claudeKeychainCli,
    KeychainUnreadableError,
    readKeychainEntry,
    readKeychainPayload,
    type SecurityCliResult,
    writeKeychainPayload,
} from "./keychain";

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });

    try {
        return await run();
    } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
}

describe("keychain off macOS", () => {
    test("readKeychainPayload returns null instead of throwing", async () => {
        await withPlatform("linux", async () => {
            expect(await readKeychainPayload()).toBeNull();
        });
    });

    test("writeKeychainPayload still refuses loudly", async () => {
        await withPlatform("linux", async () => {
            await expect(writeKeychainPayload({})).rejects.toThrow("only supported on macOS");
        });
    });
});

const LOGIN = {
    claudeAiOauth: {
        accessToken: "sk-ant-oat01-fixture",
        refreshToken: "sk-ant-ort01-fixture",
        expiresAt: 1785312000000,
        scopes: ["user:inference"],
    },
};
const JSON_LOGIN = SafeJSON.stringify(LOGIN) ?? "";

let fake: Mock<typeof claudeKeychainCli.run> | undefined;

afterEach(() => {
    fake?.mockRestore();
    fake = undefined;
});

/**
 * A fake `security` CLI. The write (`security -i` with add-generic-password) is the irreversible call: it
 * replaces Claude Code's login. The fake records it, and throws on it unless the test allows the write.
 */
function fakeSecurity(read: SecurityCliResult, allowWrite: boolean): string[] {
    const writes: string[] = [];
    fake = spyOn(claudeKeychainCli, "run").mockImplementation(async (args, stdin) => {
        if (args[0] === "find-generic-password") {
            return read;
        }

        if (args[0] === "-i") {
            writes.push(stdin ?? "");

            if (!allowWrite) {
                throw new Error("the keychain write was reached");
            }

            return { exitCode: 0, stdout: "", stderr: "" };
        }

        throw new Error(`unexpected security call: ${args.join(" ")}`);
    });

    return writes;
}

describe("keychain entry that exists but cannot be read", () => {
    test("a locked keychain reads as unreadable, never as absent", async () => {
        fakeSecurity({ exitCode: 36, stdout: "", stderr: "User interaction is not allowed." }, false);

        await withPlatform("darwin", async () => {
            const entry = await readKeychainEntry();
            expect(entry.state).toBe("unreadable");
            expect(entry.state === "unreadable" ? entry.reason : "").toContain("exited 36");
            expect(await readKeychainPayload()).toBeNull();
        });
    });

    test("a payload that does not parse is unreadable", async () => {
        fakeSecurity({ exitCode: 0, stdout: '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fix', stderr: "" }, false);

        await withPlatform("darwin", async () => {
            expect((await readKeychainEntry()).state).toBe("unreadable");
        });
    });

    test("the write refuses to replace an entry it cannot read", async () => {
        const writes = fakeSecurity(
            { exitCode: 51, stdout: "", stderr: "The user name or passphrase was wrong." },
            false
        );

        await withPlatform("darwin", async () => {
            await expect(writeKeychainPayload(LOGIN)).rejects.toBeInstanceOf(KeychainUnreadableError);
        });

        expect(writes).toEqual([]);
    });

    test("an absent entry (errSecItemNotFound) is absent, and the write goes ahead", async () => {
        const writes = fakeSecurity({ exitCode: 44, stdout: "", stderr: "could not be found" }, true);

        await withPlatform("darwin", async () => {
            expect((await readKeychainEntry()).state).toBe("absent");
            await writeKeychainPayload(LOGIN);
        });

        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain("add-generic-password -U");
    });

    test("a readable login is read whole, and replacing it on request still works", async () => {
        const writes = fakeSecurity({ exitCode: 0, stdout: `${JSON_LOGIN}\n`, stderr: "" }, true);

        await withPlatform("darwin", async () => {
            const entry = await readKeychainEntry();
            expect(entry.state === "ok" ? entry.payload.claudeAiOauth?.accessToken : undefined).toBe(
                "sk-ant-oat01-fixture"
            );
            await writeKeychainPayload(LOGIN);
        });

        expect(writes).toHaveLength(1);
    });

    test("the real security door refuses under bun test", async () => {
        await expect(claudeKeychainCli.run(["help"])).rejects.toThrow("blocked under bun test");
    });
});
