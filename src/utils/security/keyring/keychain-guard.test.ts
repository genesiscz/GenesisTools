import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import { env } from "@genesiscz/utils/env";
import { osKeyring } from "./os-keyring";
import { KEYCHAIN_SERVICE, keychainService } from "./types";

const optedIn = env.isFlag("RUN_KEYCHAIN");

/**
 * Three INDEPENDENT mechanisms keep tests away from the real OS keychain; each
 * test here pins one of them. Deleting any single mechanism must leave the
 * other two green — that redundancy is the point, not an accident.
 */
describe("keychain test lockdown", () => {
    test("layer 1: the service name is sandboxed under NODE_ENV=test", () => {
        expect(env.get("NODE_ENV")).toBe("test");
        expect(keychainService()).toBe(`${KEYCHAIN_SERVICE}-test`);
    });

    test.skipIf(optedIn)("layer 2: the keyring rung is unavailable and refuses writes", async () => {
        expect(await osKeyring.available()).toBe(false);
        expect(osKeyring.getSync?.()).toBeUndefined();
        expect(osKeyring.set(randomBytes(32))).rejects.toThrow("Refusing to write the real OS keychain");
    });

    test.skipIf(optedIn)("layer 3: @napi-rs/keyring is physically blocked by the preload mock", () => {
        expect(() => new Entry("any-service", "any-account")).toThrow("blocked under bun test");
    });
});
