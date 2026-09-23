import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { appendAudit, auditPath, findGrant, grantsPath, listGrants, rememberGrant, revokeGrants } from "./grants";
import type { ClientIdentity, GateGrant } from "./types";

const identity: ClientIdentity = {
    name: "pi",
    pid: 700,
    executable: "node",
    script: "/tmp/pi",
    command: "node pi",
    cwd: "/tmp",
    ancestors: [],
    key: "k-pi-node",
    isAncestor: true,
    injected: [],
    verified: true,
};

/** Writes prune expired grants against the real clock, so every fixture lives in the future. */
const NOW = Date.now();
const T = (seconds: number) => NOW + seconds * 1000;

function grant(overrides: Partial<GateGrant> = {}): GateGrant {
    return {
        key: identity.key,
        clientName: "pi",
        executable: "node",
        provider: "anthropic-sub",
        accountId: "acc_a",
        accountName: "alice",
        grantedAt: NOW,
        until: T(60),
        method: "touch-id",
        ...overrides,
    };
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-test-home-gate-")));
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("grants", () => {
    test("a remembered grant is found until it expires", async () => {
        await rememberGrant(grant());

        expect(findGrant(identity, "anthropic-sub", "acc_a", NOW)?.accountName).toBe("alice");
        expect(findGrant(identity, "anthropic-sub", "acc_a", T(60))).toBeUndefined();
        expect(findGrant(identity, "openai-sub", "acc_a", NOW)).toBeUndefined();
        expect(findGrant({ ...identity, key: "other" }, "anthropic-sub", "acc_a", NOW)).toBeUndefined();
    });

    test("a new grant for the same client and account replaces the old one", async () => {
        await rememberGrant(grant({ until: T(60) }));
        await rememberGrant(grant({ until: T(120) }));

        expect(listGrants(NOW)).toHaveLength(1);
        expect(listGrants(NOW)[0].until).toBe(T(120));
    });

    test("an expired grant is dropped on the next write", async () => {
        await rememberGrant(grant({ until: NOW - 1 }));
        await rememberGrant(grant({ key: "k-other", clientName: "other", accountId: "acc_b" }));

        expect(listGrants(NOW).map((g) => g.clientName)).toEqual(["other"]);
    });

    test("revoke by name, by key and everything", async () => {
        await rememberGrant(grant());
        await rememberGrant(grant({ key: "k-other", clientName: "other", accountId: "acc_b" }));

        expect(await revokeGrants("pi")).toBe(1);
        expect(listGrants(NOW).map((g) => g.clientName)).toEqual(["other"]);
        expect(await revokeGrants("k-other")).toBe(1);
        await rememberGrant(grant());
        expect(await revokeGrants("*")).toBe(1);
        expect(listGrants(NOW)).toEqual([]);
    });

    test("the files are private to the user", async () => {
        await rememberGrant(grant());
        await appendAudit({ at: "2026-09-23T00:00:00Z", event: "allowed", client: identity, account: "alice" });

        expect(statSync(grantsPath()).mode & 0o777).toBe(0o600);
        expect(statSync(auditPath()).mode & 0o777).toBe(0o600);
        expect(readFileSync(auditPath(), "utf8")).toContain('"event":"allowed"');
    });
});
