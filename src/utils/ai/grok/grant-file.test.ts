import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { SecureRef } from "@genesiscz/utils/security";
import { LockTimeoutError } from "@genesiscz/utils/storage/file-lock";
import { getActiveAuthEntry, readAuthFileAsync } from "./auth";
import { writeGrokAuthEntry } from "./auth-write";
import { type GrokGrantFileDeps, materialiseGrokGrant } from "./grant-file";

/**
 * A vault-only grok account has no `auth.json` anywhere, so a TUI launch materialises one.
 * Two things about that are worth a test rather than a comment: the file must not be readable
 * by anyone else while it exists, and a token the grok binary rotated during the session must
 * reach the vault. An OIDC refresh token is single-use, so a missed sync-back burns the grant
 * the next time anything refreshes it.
 */

const ACCOUNT = {
    id: "acc_fixture",
    name: "fixture",
    provider: "grok-sub",
    credentials: { refreshToken: { type: "secure", path: "ai/acc_fixture/refreshToken" } },
} as unknown as AccountEntry;

function deps(
    dir: string,
    onStore: (field: string, value: string) => void,
    onLockWait?: (ms: number | undefined) => void
): GrokGrantFileDeps {
    return {
        resolveGrant: async () => "access-original",
        resolveSecret: (async () => "refresh-original") as GrokGrantFileDeps["resolveSecret"],
        storeSecret: async (_accountId, field, value) => {
            onStore(field, value);
            return { type: "secure", path: `ai/acc_fixture/${field}` } as SecureRef;
        },
        loadStore: async () => ({
            withLock: async <T>(fn: (data: { accounts: AccountEntry[] }) => Promise<T>, timeoutMs?: number) => {
                onLockWait?.(timeoutMs);
                return fn({ accounts: [{ ...ACCOUNT, credentials: { ...ACCOUNT.credentials } } as AccountEntry] });
            },
        }),
        dir: () => dir,
    };
}

test("the materialised grant is private while it exists, and is removed on release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-"));
    const writes: string[] = [];
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, (field) => writes.push(field))
    );

    expect(existsSync(grant.authPath)).toBe(true);
    // 0600. A credential file at the default 0644 is readable by every process on the machine.
    expect(statSync(grant.authPath).mode & 0o777).toBe(0o600);
    expect(getActiveAuthEntry(await readAuthFileAsync(grant.authPath))?.key).toBe("access-original");

    expect(await grant.release()).toBe("unchanged");
    expect(existsSync(grant.authPath)).toBe(false);
});

test("an untouched session never writes to the vault", async () => {
    // The negative control. Syncing on every launch would rewrite the grant for no reason and
    // make a real rotation indistinguishable from a no-op in the logs.
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-idle-"));
    const writes: string[] = [];

    expect(
        await (
            await materialiseGrokGrant(
                ACCOUNT,
                deps(dir, (field) => writes.push(field))
            )
        ).release()
    ).toBe("unchanged");
    expect(writes).toEqual([]);
});

test("a token the CLI rotated during the session reaches the vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-rotated-"));
    const writes: Array<{ field: string; value: string }> = [];
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, (field, value) => writes.push({ field, value }))
    );

    // What the grok binary does mid-session: refresh, then write the pair back to the file.
    await writeGrokAuthEntry(grant.authPath, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 3_600_000,
    });

    expect(await grant.release()).toBe("synced");
    expect(writes).toEqual([
        { field: "accessToken", value: "access-rotated" },
        { field: "refreshToken", value: "refresh-rotated" },
    ]);
    expect(existsSync(grant.authPath)).toBe(false);
});

test("a file that lost its entry is reported, not silently treated as unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-lost-"));
    const writes: string[] = [];
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, (field) => writes.push(field))
    );

    await Bun.write(grant.authPath, "{}");

    expect(await grant.release()).toBe("missing");
    expect(writes).toEqual([]);
    expect(existsSync(grant.authPath)).toBe(false);
});

/**
 * Deliver a signal to ourselves and wait for the handler to finish.
 *
 * `onSignal` de-registers itself and then re-raises, so a listener of our own has to stay
 * attached for the whole exchange: the default disposition for these signals is to terminate,
 * and this is the test runner. The keeper also counts deliveries, which is what makes the
 * re-raise observable rather than assumed.
 */
async function deliverSignal(signal: NodeJS.Signals): Promise<number> {
    let delivered = 0;
    const keeper = (): void => {
        delivered++;
    };

    process.on(signal, keeper);

    try {
        process.kill(process.pid, signal);

        // Inside bun's 5 s test timeout on purpose: a handler that never re-raises should fail
        // on the `toBe(2)` below, which names the defect, rather than on a runner timeout.
        const deadline = Date.now() + 2_000;

        while (delivered < 2 && Date.now() < deadline) {
            await Bun.sleep(5);
        }

        // 🛑 Fail here, not by detaching and hoping. Removing the last listener restores the
        // signal's DEFAULT disposition, so a late re-raise would kill the whole `bun test`
        // process with 143 — a dead run that names no defect, instead of a failed assertion.
        if (delivered < 2) {
            throw new Error(`the handler never re-raised ${signal} within 2s (delivered=${delivered})`);
        }
    } finally {
        process.off(signal, keeper);
    }

    return delivered;
}

test("the materialised path is scoped to this process, so two sessions of one account cannot collide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-pid-"));
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, () => {})
    );

    expect(basename(grant.authPath)).toBe(`${ACCOUNT.id}-${process.pid}.json`);
    expect(await grant.release()).toBe("unchanged");
});

/**
 * A SIGTERM skips the launcher's `finally`. Without the handler the plaintext grant stayed on
 * disk AND the vault kept the pre-session refresh token, which the provider invalidates the
 * moment the CLI rotates it, so the next poller refresh burned the grant.
 */
test("a signal deletes the materialised file, syncs the rotated token and re-raises", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-signal-"));
    const writes: Array<{ field: string; value: string }> = [];
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, (field, value) => writes.push({ field, value }))
    );

    await writeGrokAuthEntry(grant.authPath, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 3_600_000,
    });

    // 2 = the original delivery plus the handler's re-raise. A 1 would mean the exit status the
    // parent sees is this handler's, not the signal's.
    expect(await deliverSignal("SIGTERM")).toBe(2);
    expect(existsSync(grant.authPath)).toBe(false);
    expect(writes).toEqual([
        { field: "accessToken", value: "access-rotated" },
        { field: "refreshToken", value: "refresh-rotated" },
    ]);

    // The `finished` latch: a launcher that still reaches its own cleanup after the signal must
    // not sync a second time. The file is gone, so a second pass would have nothing to read and
    // the vault would keep whatever the first pass wrote.
    expect(await grant.release()).toBe("missing");
    expect(writes).toHaveLength(2);
});

/** `deps` whose config lock refuses while `refuse` is true, the way a contended lock does. */
function timingOutDeps(
    dir: string,
    onStore: (field: string, value: string) => void,
    state: { refuse: boolean },
    waits: Array<number | undefined>
): GrokGrantFileDeps {
    const base = deps(dir, onStore, (ms) => waits.push(ms));

    return {
        ...base,
        loadStore: async () => {
            const store = await base.loadStore();

            return {
                withLock: async <T>(fn: (data: { accounts: AccountEntry[] }) => Promise<T>, timeoutMs?: number) => {
                    if (state.refuse) {
                        waits.push(timeoutMs);
                        throw new LockTimeoutError("/tmp/fixture.lock", timeoutMs ?? 0);
                    }

                    return store.withLock(fn, timeoutMs);
                },
            };
        },
    };
}

test("a signal whose vault sync times out keeps the rotated token, and the next launch recovers it", async () => {
    // 🛑 The refresh token is SINGLE-USE. The handler used to unlink the only on-disk copy and
    // then swallow the `LockTimeoutError`, so the rotated token existed nowhere: the vault still
    // held the pre-session one, which the provider had already invalidated, and the account
    // needed `tools grok login` again. The 5 s wait is the value this repo recorded as too short
    // (AiConfigStore.withLock, 2026-09-06), so the timeout is the expected case, not the exotic one.
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-signal-timeout-"));
    const writes: Array<{ field: string; value: string }> = [];
    const waits: Array<number | undefined> = [];
    const state = { refuse: true };
    const failing = timingOutDeps(dir, (field, value) => writes.push({ field, value }), state, waits);
    const grant = await materialiseGrokGrant(ACCOUNT, failing);

    await writeGrokAuthEntry(grant.authPath, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 3_600_000,
    });

    expect(await deliverSignal("SIGTERM")).toBe(2);

    // The sync genuinely failed: nothing reached the vault, and it gave up after the short wait.
    expect(writes).toEqual([]);
    expect(waits).toEqual([5_000]);
    // The session's own plaintext file is still removed — that part was never the problem.
    expect(existsSync(grant.authPath)).toBe(false);

    // …and the token is NOT gone. It waits in the account's pending grant for the next launch.
    const pending = join(dir, `${ACCOUNT.id}.pending.json`);
    expect(existsSync(pending)).toBe(true);
    expect(getActiveAuthEntry(await readAuthFileAsync(pending))?.key).toBe("access-rotated");

    // The next launch finds it and completes the sync the signal path could not.
    state.refuse = false;
    const next = await materialiseGrokGrant(ACCOUNT, failing);

    expect(writes).toEqual([
        { field: "accessToken", value: "access-rotated" },
        { field: "refreshToken", value: "refresh-rotated" },
    ]);
    expect(existsSync(pending)).toBe(false);
    await next.release();
});

test("an ordinary release keeps the full networked budget, so the short signal wait did not leak", async () => {
    // NEGATIVE CONTROL for the test above. Ctrl-C has to return the terminal, so the signal path
    // waits seconds; a normal exit has no such deadline and must still wait out a real refresh.
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-release-wait-"));
    const releaseWaits: Array<number | undefined> = [];
    const released = await materialiseGrokGrant(
        ACCOUNT,
        deps(
            dir,
            () => {},
            (ms) => releaseWaits.push(ms)
        )
    );

    await writeGrokAuthEntry(released.authPath, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 3_600_000,
    });

    expect(await released.release()).toBe("synced");
    expect(releaseWaits).toEqual([60_000]);
});

test("a release whose vault sync fails keeps the token too, instead of dying with it in memory", async () => {
    // The same hole on the ordinary path: `release()` deletes the file before syncing, so a
    // rejection there lost the rotated token just as completely as the signal path did.
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-release-timeout-"));
    const writes: Array<{ field: string; value: string }> = [];
    const state = { refuse: true };
    const failing = timingOutDeps(dir, (field, value) => writes.push({ field, value }), state, []);
    const grant = await materialiseGrokGrant(ACCOUNT, failing);

    await writeGrokAuthEntry(grant.authPath, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 3_600_000,
    });

    await expect(grant.release()).rejects.toThrow(LockTimeoutError);
    expect(writes).toEqual([]);
    expect(existsSync(join(dir, `${ACCOUNT.id}.pending.json`))).toBe(true);
});

test("a signal on an untouched session still removes the file and leaves the vault alone", async () => {
    // The negative control for the path above: the handler must not write on every exit, or a
    // real rotation becomes indistinguishable from an ordinary Ctrl-C in the vault's history.
    const dir = mkdtempSync(join(tmpdir(), "grok-grant-signal-idle-"));
    const writes: string[] = [];
    const grant = await materialiseGrokGrant(
        ACCOUNT,
        deps(dir, (field) => writes.push(field))
    );

    expect(await deliverSignal("SIGINT")).toBe(2);
    expect(existsSync(grant.authPath)).toBe(false);
    expect(writes).toEqual([]);
});
