import { mock } from "bun:test";

/**
 * Make the real OS keychain PHYSICALLY unreachable inside test processes.
 *
 * The keychain is machine-global state: it ignores GENESIS_TOOLS_HOME, so one
 * test (or one CLI smoke spawned by an agent) storing a vault master key
 * changes what every later test on the machine observes — the secretsToVault
 * migration stops deferring the moment a key is reachable. That happened on
 * 2026-07-29 and broke six unrelated suites.
 *
 * This preload replaces `@napi-rs/keyring` with a constructor that throws, so
 * no in-process code path — including future code whose authors never heard of
 * this rule — can read or write a real keychain item under `bun test`. It is
 * the third of three independent mechanisms (os-keyring's under-test block and
 * the `keychainService()` test-suffixed item name being the others); any one
 * alone is sufficient, and deleting one must not be fatal.
 *
 * RUN_KEYCHAIN=1 opts out of the mock for a deliberate keyring integration
 * test; the service-name sandbox still applies there, so even opted-in tests
 * touch a `genesis-tools-test` item, never the real master key.
 *
 * Uses process.env directly on purpose: preloads are test infrastructure (like
 * scripts/) and must not drag the app env facade into every test's module
 * graph before mocks are installed.
 */
if (process.env.RUN_KEYCHAIN !== "1") {
    mock.module("@napi-rs/keyring", () => ({
        Entry: class BlockedKeyringEntry {
            constructor() {
                throw new Error(
                    "@napi-rs/keyring is blocked under bun test — the real OS keychain must never be touched by tests. Fake the ladder with _setMasterKeyProvidersForTest, or set RUN_KEYCHAIN=1 for a deliberate keyring integration test (which still uses the sandboxed genesis-tools-test item)."
                );
            }
        },
    }));
}
