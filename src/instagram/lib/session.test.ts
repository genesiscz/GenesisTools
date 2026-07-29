import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { __testing, resolveSession, writeSessionConfig } from "./session";

/**
 * Every key `resolveSession` can read. They are cleared before each case because
 * a developer running the suite with a real IG_SESSIONID exported would
 * otherwise see the "no session" assertions fail for reasons that have nothing
 * to do with the code.
 */
const SESSION_KEYS = ["IG_SESSIONID", "INSTAGRAM_SESSIONID", "IG_CSRFTOKEN", "IG_ALT_COOKIE"] as const;

let home: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
    // The config branch writes a real config.json, so the storage root is
    // redirected at a fresh tmp dir rather than the user's ~/.genesis-tools.
    saved.set("GENESIS_TOOLS_HOME", env.get("GENESIS_TOOLS_HOME"));
    home = mkdtempSync(join(tmpdir(), "instagram-session-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    for (const key of SESSION_KEYS) {
        saved.set(key, env.get(key));
        env.testing.unset(key);
    }
});

afterEach(() => {
    for (const [key, value] of saved) {
        if (value === undefined) {
            env.testing.unset(key);
        } else {
            env.testing.set(key, value);
        }
    }

    saved.clear();
    rmSync(home, { recursive: true, force: true });
});

describe("resolveSession", () => {
    test("returns undefined when nothing supplies a cookie", async () => {
        // Anonymous commands must keep working with no session at all, so the
        // absence of one is a value, not an error.
        expect(await resolveSession()).toBeUndefined();
    });

    test("takes the explicit flag and reports it as the source", async () => {
        const session = await resolveSession("abc123");

        expect(session?.sessionId).toBe("abc123");
        expect(session?.source).toBe("flag");
        expect(session?.envKey).toBeUndefined();
    });

    test("pulls both halves out of a pasted cookie string", async () => {
        // Browsers copy the whole `a=1; b=2` pair, which is what users paste.
        const session = await resolveSession("csrftoken=tok999; sessionid=sess777; ds_user_id=1");

        expect(session?.sessionId).toBe("sess777");
        expect(session?.csrfToken).toBe("tok999");
    });

    test("never pairs an explicit session with the environment's csrftoken", async () => {
        // The flag exists to OVERRIDE the environment's session. Borrowing that
        // session's csrftoken would hand Instagram a new cookie wearing the old
        // account's token — the mismatch this tool warns about, manufactured by
        // the tool itself. Better to send none and log the warning.
        env.testing.set("IG_SESSIONID", "old-session");
        env.testing.set("IG_CSRFTOKEN", "old-token");

        const session = await resolveSession("new-session");

        expect(session?.sessionId).toBe("new-session");
        expect(session?.csrfToken).toBeUndefined();
    });

    test("accepts a csrftoken passed explicitly alongside the session flag", async () => {
        env.testing.set("IG_CSRFTOKEN", "ambient-and-unrelated");

        const session = await resolveSession("new-session", "paired-token");

        expect(session?.sessionId).toBe("new-session");
        expect(session?.csrfToken).toBe("paired-token");
    });

    test("prefers an explicit csrftoken over one embedded in the pasted cookie", async () => {
        const session = await resolveSession("csrftoken=embedded; sessionid=sess", "explicit");

        expect(session?.csrfToken).toBe("explicit");
    });

    test("reads IG_SESSIONID and names the variable it came from", async () => {
        env.testing.set("IG_SESSIONID", "env-session");
        env.testing.set("IG_CSRFTOKEN", "env-csrf");

        const session = await resolveSession();

        expect(session?.sessionId).toBe("env-session");
        expect(session?.csrfToken).toBe("env-csrf");
        expect(session?.source).toBe("env");
        expect(session?.envKey).toBe("IG_SESSIONID");
    });

    test("prefers the explicit flag over the environment", async () => {
        env.testing.set("IG_SESSIONID", "env-session");

        const session = await resolveSession("flag-session");

        expect(session?.sessionId).toBe("flag-session");
        expect(session?.source).toBe("flag");
    });

    test("resolves through a config-referenced env var, and stores only its name", async () => {
        // The cookie is a live credential, so config holds the variable NAME and
        // the value is read at use time — the tokens.apiKeyEnv convention.
        await writeSessionConfig({ sessionIdEnv: "IG_ALT_COOKIE" });
        env.testing.set("IG_ALT_COOKIE", "alt-session");

        const session = await resolveSession();

        expect(session?.sessionId).toBe("alt-session");
        expect(session?.source).toBe("env");
        expect(session?.envKey).toBe("IG_ALT_COOKIE");

        const written = await Bun.file(join(home, ".genesis-tools", "instagram", "config.json")).text();
        expect(written).toContain("IG_ALT_COOKIE");
        expect(written).not.toContain("alt-session");
    });

    test("prefers IG_SESSIONID over a config-referenced variable", async () => {
        await writeSessionConfig({ sessionIdEnv: "IG_ALT_COOKIE" });
        env.testing.set("IG_ALT_COOKIE", "alt-session");
        env.testing.set("IG_SESSIONID", "direct-session");

        const session = await resolveSession();

        expect(session?.sessionId).toBe("direct-session");
        expect(session?.envKey).toBe("IG_SESSIONID");
    });

    test("reports no session when the configured variable is unset or blank", async () => {
        // A dangling reference must not resolve to an empty-string cookie, which
        // would be sent as a real one and rejected as an expired session.
        await writeSessionConfig({ sessionIdEnv: "IG_ALT_COOKIE" });

        expect(await resolveSession()).toBeUndefined();

        env.testing.set("IG_ALT_COOKIE", "   ");
        expect(await resolveSession()).toBeUndefined();
    });
});

describe("cookie parsing helpers", () => {
    test("strips a sessionid= prefix and a trailing semicolon", () => {
        expect(__testing.stripCookiePrefix("sessionid=abc;")).toBe("abc");
        expect(__testing.stripCookiePrefix("  abc  ")).toBe("abc");
        expect(__testing.stripCookiePrefix("other=1; sessionid=abc")).toBe("abc");
    });

    test("returns undefined for a cookie that is not present", () => {
        expect(__testing.extractCookie("sessionid=abc", "csrftoken")).toBeUndefined();
        expect(__testing.extractCookie("csrftoken=xyz; sessionid=abc", "csrftoken")).toBe("xyz");
    });
});
