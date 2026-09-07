import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpstreamStatusError } from "@genesiscz/utils/ai/http-auth";
import { env } from "@genesiscz/utils/env";
import {
    backoffMs,
    blockedEntry,
    credentialMovedSince,
    isTransportFailure,
    loadPollGate,
    MAX_BACKOFF_MS,
    type PollGate,
    pruneGate,
    recordFailure,
    recordSuccess,
    savePollGate,
} from "./poll-gate";
import { __resetUsagePollStorage } from "./storage";

const NOW = 1_800_000_000_000;

describe("backoffMs", () => {
    test("the first failure never blocks — one 429 is routine", () => {
        expect(backoffMs(1)).toBe(0);
    });

    test("climbs with consecutive failures", () => {
        expect(backoffMs(2)).toBe(5 * 60_000);
        expect(backoffMs(3)).toBe(30 * 60_000);
        expect(backoffMs(4)).toBe(2 * 3_600_000);
    });

    test("caps instead of growing forever", () => {
        expect(backoffMs(5)).toBe(MAX_BACKOFF_MS);
        expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    });
});

describe("recordFailure", () => {
    test("a single failure leaves the account pollable", () => {
        const gate = recordFailure({}, "a", "Usage API 429", NOW);
        expect(gate.a.failures).toBe(1);
        expect(blockedEntry(gate, "a", NOW)).toBeNull();
    });

    test("the second consecutive failure blocks for 5 minutes", () => {
        let gate = recordFailure({}, "a", "Usage API 429", NOW);
        gate = recordFailure(gate, "a", "Usage API 429", NOW);

        expect(blockedEntry(gate, "a", NOW)?.reason).toBe("Usage API 429");
        expect(blockedEntry(gate, "a", NOW + 5 * 60_000)).toBeNull();
    });

    test("a dead account converges on the 6h cap", () => {
        let gate: PollGate = {};

        for (let i = 0; i < 8; i++) {
            gate = recordFailure(gate, "dead", "invalid_grant", NOW);
        }

        expect(gate.dead.blockedUntil - NOW).toBe(MAX_BACKOFF_MS);
    });

    test("does not mutate the gate it was given", () => {
        const original: PollGate = {};
        recordFailure(original, "a", "boom", NOW);
        expect(original.a).toBeUndefined();
    });
});

describe("recordSuccess", () => {
    test("clears the backoff so the next poll runs immediately", () => {
        let gate = recordFailure({}, "a", "Usage API 429", NOW);
        gate = recordFailure(gate, "a", "Usage API 429", NOW);
        gate = recordSuccess(gate, "a");

        expect(gate.a).toBeUndefined();
        expect(blockedEntry(gate, "a", NOW)).toBeNull();
    });

    test("returns the same object when there was nothing to clear", () => {
        const gate: PollGate = {};
        expect(recordSuccess(gate, "a")).toBe(gate);
    });
});

describe("pruneGate", () => {
    test("forgets accounts that are no longer configured", () => {
        const gate = recordFailure(recordFailure({}, "gone", "x", NOW), "kept", "y", NOW);
        const pruned = pruneGate(gate, ["kept"]);

        expect(Object.keys(pruned)).toEqual(["kept"]);
    });
});

/**
 * Codex and grok are logged in with their own CLIs, which we cannot hook, so the only
 * evidence a dead session was repaired is that the vendor auth file moved. Before this,
 * a re-login left the account dark for the rest of its backoff — up to six hours.
 */
describe("credentialMovedSince", () => {
    function blocked(): PollGate {
        return recordFailure(recordFailure({}, "work", "Grok session token expired", NOW), "work", "again", NOW);
    }

    test("a credential written after the failure releases the block", () => {
        const gate = blocked();

        expect(credentialMovedSince(gate.work, NOW + 1_000)).toBe(true);
        expect(blockedEntry(gate, "work", NOW, NOW + 1_000)).toBeNull();
    });

    test("a credential older than the failure changes nothing", () => {
        const gate = blocked();

        expect(credentialMovedSince(gate.work, NOW - 1_000)).toBe(false);
        expect(blockedEntry(gate, "work", NOW, NOW - 1_000)?.reason).toBe("again");
    });

    test("no stamp at all leaves the block exactly as it was", () => {
        const gate = blocked();

        expect(credentialMovedSince(gate.work, undefined)).toBe(false);
        expect(blockedEntry(gate, "work", NOW)?.reason).toBe("again");
    });

    // Gate files written before `failedAt` existed must keep working: the rule cannot
    // fire without a stamp to compare against, which is the pre-existing behaviour.
    test("an entry from an older gate file is never released by accident", () => {
        const legacy: PollGate = { work: { failures: 3, blockedUntil: NOW + 3_600_000, reason: "invalid_grant" } };

        expect(credentialMovedSince(legacy.work, NOW + 1_000)).toBe(false);
        expect(blockedEntry(legacy, "work", NOW, NOW + 1_000)?.reason).toBe("invalid_grant");
    });

    test("every recorded failure carries the moment it happened", () => {
        expect(recordFailure({}, "work", "boom", NOW).work.failedAt).toBe(NOW);
        expect(recordFailure({}, "work", "offline", NOW, true).work.failedAt).toBe(NOW);
    });
});

describe("isTransportFailure", () => {
    // Shapes captured from Bun 1.3.13 on this machine, not invented: a refused
    // port and an unresolvable host both arrive as `ConnectionRefused`.
    test("recognises the error the 2026-08-30 blackout was made of", () => {
        const err = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
            code: "ConnectionRefused",
        });

        expect(isTransportFailure(err)).toBe(true);
    });

    test("recognises a posix socket code on the cause", () => {
        expect(isTransportFailure(Object.assign(new Error("boom"), { cause: { code: "ETIMEDOUT" } }))).toBe(true);
    });

    test("still catches an error that was stringified before it got here", () => {
        expect(isTransportFailure("Error: Unable to connect. Is the computer able to access the url?")).toBe(true);
    });

    test("a lock timeout is transport: no request was sent and the lock is shared by every account", () => {
        const err = Object.assign(new Error("Failed to acquire file lock at /x/config.json.lock within 5000ms"), {
            name: "LockTimeoutError",
        });

        expect(isTransportFailure(err)).toBe(true);
        expect(isTransportFailure(String(err))).toBe(true);
    });

    test("the refresh wrapper's DNS wording and its kept cause are both transport", () => {
        const dns = Object.assign(new Error("Was there a typo in the url or port?"), { code: "ConnectionRefused" });
        const wrapped = new Error('Failed to refresh token for "work": Was there a typo in the url or port?.', {
            cause: dns,
        });

        expect(isTransportFailure(wrapped)).toBe(true);
        expect(
            isTransportFailure(new Error('Failed to refresh token for "work": Was there a typo in the url or port?.'))
        ).toBe(true);
        expect(isTransportFailure(new Error("plain failure", { cause: dns }))).toBe(true);
    });

    /**
     * The three request deadlines this campaign added. `AbortSignal.timeout` rejects with a
     * DOMException named `TimeoutError` whose `code` is the NUMBER 23 (observed on Bun
     * 1.3.13), so the string-code set never matched it and a stalled network climbed the 6h
     * ladder rather than the 5-minute transport one (review t8).
     */
    test("a request deadline is transport, whichever of the three fired", () => {
        const abort = Object.assign(new Error("The operation timed out."), { name: "TimeoutError", code: 23 });

        expect(isTransportFailure(abort)).toBe(true);
        expect(isTransportFailure("The operation timed out.")).toBe(true);
        expect(isTransportFailure(new Error("grok usage read timed out after 8000ms"))).toBe(true);
        expect(isTransportFailure(new Error("codex account/rateLimits/read timed out after 10000ms"))).toBe(true);
    });

    test("an expired token is NOT transport — it must keep the long ladder", () => {
        // The whole point of the split: a dead account still earns a 6h block.
        expect(isTransportFailure(new Error("Token expired (invalid_grant). Run: tools claude login foo"))).toBe(false);
    });

    test("an HTTP-level error is NOT transport — the server answered", () => {
        expect(isTransportFailure(new Error("Usage API 401: unauthorized"))).toBe(false);
        expect(isTransportFailure(new Error("Usage API 429: rate limited"))).toBe(false);
        // A body that merely mentions a timeout still answered, so it keeps the long ladder.
        expect(isTransportFailure(new Error("Usage API 504: upstream request timeout"))).toBe(false);
    });

    // Captured from Bun 1.3.13 on this machine: `AbortSignal.timeout()` rejects with a
    // DOMException named TimeoutError whose `code` is the NUMBER 23, so the string-code
    // set never saw it and a 20s stall on the usage endpoint climbed the account ladder.
    test("a fetch deadline is transport — the request never got a response", () => {
        const timeout = Object.assign(new Error("The operation timed out."), {
            name: "TimeoutError",
            code: 23,
        });

        expect(isTransportFailure(timeout)).toBe(true);
        expect(isTransportFailure(String(timeout))).toBe(true);
    });

    test("an aborted request is transport, including on the cause of a wrapper", () => {
        const aborted = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

        expect(isTransportFailure(aborted)).toBe(true);
        expect(isTransportFailure(new Error("grok refresh failed", { cause: aborted }))).toBe(true);
    });

    // Our own `withTimeout` wrappers (grok usage, the codex app-server handshake) throw a
    // plain Error, so only the wording can classify them.
    test("our own withTimeout wording is transport too", () => {
        expect(isTransportFailure(new Error("grok usage read timed out after 20000ms"))).toBe(true);
        expect(isTransportFailure(new Error("codex app-server initialize timed out after 10000ms"))).toBe(true);
    });

    // Negative control: the word "timeout" inside an account-level payload must not
    // downgrade the ladder the dead account has earned.
    test("a provider payload that merely mentions a timeout is still an account failure", () => {
        expect(isTransportFailure(new Error('Usage API 400: {"error":"request_timeout_config"}'))).toBe(false);
    });

    // A 5xx reaches every account of that provider in the same round and clears up on its
    // own, so pinning one account for six hours outlives the outage by hours.
    test("an outage status is transport even though the server answered", () => {
        expect(isTransportFailure(new UpstreamStatusError(503, "Usage API 503: unavailable"))).toBe(true);
        expect(isTransportFailure(new UpstreamStatusError(502, "Grok API /billing failed: HTTP 502"))).toBe(true);
        expect(isTransportFailure(new UpstreamStatusError(408, "Usage API 408: request timeout"))).toBe(true);
    });

    // The split only pays off if the account half survives it.
    test("an auth or rate-limit status keeps the long account ladder", () => {
        expect(isTransportFailure(new UpstreamStatusError(401, "Usage API 401: unauthorized"))).toBe(false);
        expect(isTransportFailure(new UpstreamStatusError(403, "not allowed for this org"))).toBe(false);
        expect(isTransportFailure(new UpstreamStatusError(429, "Usage API 429: rate limited"))).toBe(false);
        expect(isTransportFailure(Object.assign(new Error("Usage API 429"), { statusCode: 429 }))).toBe(false);
    });
});

describe("recordFailure with a transport failure", () => {
    const NET = "Error: Unable to connect. Is the computer able to access the url?";

    test("caps at 5 minutes where an account failure would take 6 hours", () => {
        let ladder: PollGate = {};
        let capped: PollGate = {};

        for (let i = 0; i < 5; i++) {
            ladder = recordFailure(ladder, "a", "Usage API 401", NOW);
            capped = recordFailure(capped, "a", NET, NOW, true);
        }

        expect(ladder.a.blockedUntil - NOW).toBe(MAX_BACKOFF_MS);
        expect(capped.a.blockedUntil - NOW).toBe(5 * 60_000);
    });

    test("a recovered network is retried within five minutes, not six hours", () => {
        // The regression itself: 5 consecutive blips left every account blocked
        // for 6h, so connectivity could return unnoticed for most of a day.
        let gate: PollGate = {};

        for (let i = 0; i < 20; i++) {
            gate = recordFailure(gate, "a", NET, NOW, true);
        }

        expect(blockedEntry(gate, "a", NOW + 5 * 60_000)).toBeNull();
    });

    test("counts on its own ladder and leaves the account ladder untouched", () => {
        let gate = recordFailure({}, "a", NET, NOW, true);
        gate = recordFailure(gate, "a", NET, NOW, true);

        expect(gate.a.transportFailures).toBe(2);
        expect(gate.a.failures).toBe(0);
    });

    test("an outage does not pre-load the ladder, so the first 429 after it still does not block", () => {
        // The regression: five minutes of dropped wifi climbed the shared ladder
        // to 5, and the next routine 429 earned the 6h block the ladder's own
        // comment promises a first 429 never gets.
        let gate: PollGate = {};

        for (let i = 0; i < 5; i++) {
            gate = recordFailure(gate, "a", NET, NOW, true);
        }

        gate = recordFailure(gate, "a", "Usage API 429", NOW);

        expect(gate.a.failures).toBe(1);
        expect(blockedEntry(gate, "a", NOW)).toBeNull();
    });

    test("a failure that reached Anthropic clears the transport streak", () => {
        let gate = recordFailure({}, "a", NET, NOW, true);
        gate = recordFailure(gate, "a", "Usage API 401", NOW);

        expect(gate.a.transportFailures).toBe(0);
    });

    test("one success clears a network streak completely", () => {
        let gate = recordFailure({}, "a", NET, NOW, true);
        gate = recordFailure(gate, "a", NET, NOW, true);

        expect(recordSuccess(gate, "a").a).toBeUndefined();
    });

    test("defaults to the account ladder when the flag is omitted", () => {
        let gate: PollGate = {};

        for (let i = 0; i < 5; i++) {
            gate = recordFailure(gate, "a", "Usage API 401", NOW);
        }

        expect(gate.a.blockedUntil - NOW).toBe(MAX_BACKOFF_MS);
    });
});

describe("per-provider gate files", () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }

        env.testing.unset("GENESIS_TOOLS_HOME");
        __resetUsagePollStorage();
    });

    function useTempHome(): void {
        const home = mkdtempSync(join(tmpdir(), "ai-usage-gate-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        __resetUsagePollStorage();
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    }

    test("a blocked openai-sub account does not block the same name under anthropic-sub", async () => {
        useTempHome();
        const now = Date.now();
        const blocked = recordFailure(recordFailure({}, "work", "app-server timeout", now), "work", "again", now);

        await savePollGate("openai-sub", blocked);

        expect(blockedEntry(await loadPollGate("openai-sub"), "work", now)).not.toBeNull();
        expect(blockedEntry(await loadPollGate("anthropic-sub"), "work", now)).toBeNull();
    });

    test("an unreadable or missing gate treats every account as due", async () => {
        useTempHome();

        expect(await loadPollGate("grok-sub")).toEqual({});
    });
});
