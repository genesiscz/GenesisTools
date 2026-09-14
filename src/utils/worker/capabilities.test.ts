import { describe, expect, test } from "bun:test";
import { WORKER_CAPABILITIES } from "./capabilities";

describe("WORKER_CAPABILITIES", () => {
    test("safety-critical fields cannot silently drift", () => {
        // These are the facts the docs point at instead of restating. A change
        // here is a change to REALITY (a new approval channel, a new sandbox)
        // and must be made deliberately, with the backends' docs in the same
        // commit.
        expect(WORKER_CAPABILITIES.claude.approvals).toBe("none");
        expect(WORKER_CAPABILITIES.claude.sandbox).toBe("none");
        expect(WORKER_CAPABILITIES.claude.accountRequired).toBe(true);
        expect(WORKER_CAPABILITIES.grok.approvals).toBe("none");
        expect(WORKER_CAPABILITIES.grok.sandbox).toBe("cwd-jail");
        expect(WORKER_CAPABILITIES.codex.approvals).toBe("mid-turn");
        expect(WORKER_CAPABILITIES.codex.sandbox).toBe("workspace-write+roots");
    });

    test("only codex steers mid-turn", () => {
        expect(WORKER_CAPABILITIES.codex.steering).toBe("mid-turn");
        expect(WORKER_CAPABILITIES.grok.steering).toBe("between-turns");
        expect(WORKER_CAPABILITIES.claude.steering).toBe("between-turns");
    });

    test("a backend that cannot pin an account says so, with the reason the CLI prints", () => {
        // Grok identifies a login by an auth FILE, never by a name, so `--account` could only
        // ever be a silent no-op there. The matrix carries the refusal text itself, so the
        // hidden flag's description, the driver's throw and the legacy door all quote one string.
        expect(WORKER_CAPABILITIES.grok.accountUnsupported).toContain("auth FILE");
        expect(WORKER_CAPABILITIES.grok.accountUnsupported).toContain("GROK_AUTH_PATH");
        expect(WORKER_CAPABILITIES.grok.accountRequired).toBe(false);

        // The two backends that DO pin an account must not claim otherwise.
        expect(WORKER_CAPABILITIES.claude.accountUnsupported).toBeUndefined();
        expect(WORKER_CAPABILITIES.codex.accountUnsupported).toBeUndefined();
    });

    test("absent verbs carry a reason", () => {
        for (const capabilities of Object.values(WORKER_CAPABILITIES)) {
            for (const [verb, reason] of Object.entries(capabilities.absentVerbs)) {
                expect(verb.length).toBeGreaterThan(0);
                expect(reason.length).toBeGreaterThan(10);
                expect(capabilities.verbs).not.toContain(verb);
            }
        }
    });
});
