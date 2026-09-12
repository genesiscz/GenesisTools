import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { SecureRef } from "@genesiscz/utils/security";
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

function deps(dir: string, onStore: (field: string, value: string) => void): GrokGrantFileDeps {
    return {
        resolveGrant: async () => "access-original",
        resolveSecret: (async () => "refresh-original") as GrokGrantFileDeps["resolveSecret"],
        storeSecret: async (_accountId, field, value) => {
            onStore(field, value);
            return { type: "secure", path: `ai/acc_fixture/${field}` } as SecureRef;
        },
        loadStore: async () => ({
            withLock: async <T>(fn: (data: { accounts: AccountEntry[] }) => Promise<T>) =>
                fn({ accounts: [{ ...ACCOUNT, credentials: { ...ACCOUNT.credentials } } as AccountEntry] }),
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
