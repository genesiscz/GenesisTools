import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import { claimIsLive, claimSessionName, isActiveCodexSession } from "./spawn";
import { type CodexSessionMeta, CodexSessionStore } from "./store";

/**
 * The window between `claimSessionName` and the daemon's first `writeMeta`.
 *
 * In it `daemonPid` is still 0, and `isProcessAlive` rejects any pid `<= 0`, so `classifyPid`
 * calls the record "dead". A second `tools codex spawn --name x` landing there read the fresh
 * claim as a free name and overwrote it, stranding the first daemon with nothing pointing at its
 * pid — the exact race the O_EXCL claim was written to close.
 */
function claim(overrides: Partial<CodexSessionMeta> = {}): CodexSessionMeta {
    return {
        name: "fixture",
        daemonPid: 0,
        claimedByPid: process.pid,
        claimedAt: new Date().toISOString(),
        cwd: "/tmp/fixture",
        sandbox: "read-only",
        approvalPolicy: "never",
        writePolicy: "deny",
        status: "starting",
        agentName: "codex_fixture",
        rendezvousSession: "codex-fixture",
        agentsEnabled: false,
        startedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString(),
        codexVersion: "0.0.0",
        pendingApprovals: {},
        ...overrides,
    };
}

test("a fresh claim by a live process holds the name even though no daemon pid exists yet", () => {
    expect(claimIsLive(claim())).toBe(true);
});

test("a claim by a process that is gone does not hold the name", () => {
    // Two different branches, not one case twice: `0` is "no claimant was recorded at all" and
    // never reaches a liveness check, while `-1` is a pid that cannot exist and is the one that
    // exercises `classifyPid`.
    expect(claimIsLive(claim({ claimedByPid: 0 }))).toBe(false);
    expect(claimIsLive(claim({ claimedByPid: -1 }))).toBe(false);
});

test("a claim whose pid now belongs to another program does not hold the name", () => {
    // Liveness alone let a recycled pid hold the name for the full grace window — the same
    // pid-reuse bug `isCodexDaemonPid` already carries a command-line matcher for.
    const recycled = claim({ claimedByPid: process.pid, claimedCommand: "/usr/bin/some-other-program --serve" });

    expect(claimIsLive(recycled)).toBe(false);
});

test("NEGATIVE CONTROL: the claimant's own command line still holds the name", () => {
    const mine = claim({ claimedByPid: process.pid, claimedCommand: readProcessCommand(process.pid) ?? undefined });

    expect(claimIsLive(mine)).toBe(true);
});

test("a claim older than the grace window stops holding the name", () => {
    // Without the age bound, a process killed inside the window would hold the name forever.
    const old = new Date(Date.now() - 60_000).toISOString();

    expect(claimIsLive(claim({ claimedAt: old }))).toBe(false);
});

test("NEGATIVE CONTROL: a record with a real daemon pid is not judged by the claim", () => {
    // Once the daemon pid is recorded the claim is irrelevant, and liveness must come from the
    // daemon's own pid instead — otherwise the name would outlive the daemon that owned it.
    expect(claimIsLive(claim({ daemonPid: 4242 }))).toBe(false);
});

test("NEGATIVE CONTROL: a claim on a finished session does not hold the name", () => {
    expect(claimIsLive(claim({ status: "closed" }))).toBe(false);
    expect(claimIsLive(claim({ status: "ready" }))).toBe(false);
});

/**
 * Everything above tests the PREDICATE. These test the WIRING, which is what the race actually
 * runs through: `isActiveCodexSession` consulting the predicate, and `claimSessionName` stamping
 * the claim onto the record it writes. Both used to be deletable with every test still green.
 */
describe("the claim as spawn wires it", () => {
    test("isActiveCodexSession asks the claim, not only the daemon pid", () => {
        // The daemon pid is 0 for the whole claim window, so without the claim this answers
        // "inactive" and the second spawn overwrites the first's record.
        expect(isActiveCodexSession(claim(), "fixture")).toBe(true);
    });

    test("claimSessionName stamps the claim into the record it writes", async () => {
        const home = mkdtempSync(join(tmpdir(), "codex-claim-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new CodexSessionStore();
            claimSessionName(store, claim({ name: "wiring", claimedByPid: undefined, claimedAt: undefined }));

            const stored = store.readMeta("wiring");

            expect(stored?.claimedByPid).toBe(process.pid);
            expect(stored?.claimedAt).toBeTruthy();
            expect(claimIsLive(stored as CodexSessionMeta)).toBe(true);
        });
    });

    test("a second claim of the same name is refused while the first still holds it", async () => {
        const home = mkdtempSync(join(tmpdir(), "codex-claim-race-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new CodexSessionStore();
            claimSessionName(store, claim({ name: "wiring", claimedByPid: undefined, claimedAt: undefined }));

            // The O_EXCL write loses, the loser re-reads the claim, and the claim must still say
            // "held" — otherwise the loser overwrites the winner's record.
            expect(() =>
                claimSessionName(store, claim({ name: "wiring", claimedByPid: undefined, claimedAt: undefined }))
            ).toThrow(/already active/);
        });
    });

    test("the refusal names the claiming process instead of the pid 0 the window always has", async () => {
        const home = mkdtempSync(join(tmpdir(), "codex-claim-holder-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new CodexSessionStore();
            claimSessionName(store, claim({ name: "wiring", claimedByPid: undefined, claimedAt: undefined }));

            expect(() =>
                claimSessionName(store, claim({ name: "wiring", claimedByPid: undefined, claimedAt: undefined }))
            ).toThrow(new RegExp(`claimed by pid ${process.pid}`));
        });
    });
});
