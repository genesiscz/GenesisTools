/**
 * Ported from a sibling internal repo (`src/jenkins-mcp/lib/credentials.test.ts`,
 * commit c7c38efcc8) together with the login flow it covers. Two things changed for
 * this repo: `resolveAuth()` reads `env.jenkins.*` instead of taking a
 * `ProcessEnv` argument, so the environment cases go through
 * `env.testing.withOverrides`, and `secretStoreAvailable()` is async here.
 *
 * The store is mocked, deliberately. What these tests pin is the SHAPE of what
 * gets written (one opaque object, never a key/value spread) and the failure
 * wording, neither of which needs a real vault. Reaching the real vault would
 * also mean reaching the master-key ladder, which the security tests forbid.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const store = {
    vault: null as string | null,
    available: true,
    writes: 0,
    /** Simulates the vault being present but unreadable (locked, bad key, IO). */
    readThrows: false,
};

mock.module("./credentialStore", () => ({
    SECRET_SERVICE: "jenkins",
    SECRET_ACCOUNT: "credentials",
    SECRET_PATH: "jenkins/credentials",
    secretStoreName: () => "the GenesisTools vault",
    secretStoreAvailable: async () => store.available,
    readVault: async () => {
        if (store.readThrows) {
            throw new Error("vault is locked");
        }

        return store.available ? store.vault : null;
    },
    writeVault: async (value: string) => {
        if (!store.available) {
            return false;
        }

        store.vault = value;
        store.writes++;
        return true;
    },
    clearVault: async () => {
        store.vault = null;
        return true;
    },
}));

const {
    forgetAuth,
    hostKey,
    JenkinsAuthMissingError,
    loadVault,
    readStoredAuth,
    resolveAuth,
    saveAuth,
    SETUP_COMMAND,
    tokenPageUrl,
} = await import("./credentials");

const AUTH = { url: "https://jenkins.example/", user: "someone", token: "t0ken" };
const OTHER = { url: "https://other.example", user: "else", token: "other-token" };

/** Every case states the whole environment, so an exported JENKINS_* cannot leak in. */
const NOTHING_SET = { JENKINS_URL: undefined, JENKINS_USER: undefined, JENKINS_TOKEN: undefined };

beforeEach(() => {
    store.vault = null;
    store.available = true;
    store.writes = 0;
    store.readThrows = false;
});

describe("an unreadable vault is never mistaken for an empty one", () => {
    test("saveAuth REFUSES and writes nothing, so other hosts cannot be dropped", async () => {
        await saveAuth(AUTH);
        const before = store.vault;
        store.readThrows = true;

        // The write spreads the existing hosts. Treating a failed read as "no
        // hosts" would replace every stored credential with just the new one.
        expect(saveAuth(OTHER)).rejects.toThrow(/Refusing to save/);
        await Bun.sleep(0);

        expect(store.vault).toBe(before);
        expect(store.writes).toBe(1);
    });

    test("forgetAuth refuses too, for the same reason", async () => {
        await saveAuth(AUTH);
        store.readThrows = true;

        expect(forgetAuth()).rejects.toThrow("vault is locked");
    });

    test("a READER treats it as absent instead of throwing at the user", async () => {
        await saveAuth(AUTH);
        store.readThrows = true;

        expect(await readStoredAuth()).toBeNull();
    });

    test("negative control: with the vault readable, a second host still joins the same object", async () => {
        await saveAuth(AUTH);
        await saveAuth(OTHER);

        const vault = await loadVault();

        expect(Object.keys(vault?.hosts ?? {})).toEqual(["jenkins.example", "other.example"]);
        expect(store.writes).toBe(2);
    });
});

describe("hostKey", () => {
    test("keys on the host so several Jenkins instances coexist", () => {
        expect(hostKey("https://jenkins.example/")).toBe("jenkins.example");
        expect(hostKey("https://jenkins.example/job/x/1/")).toBe("jenkins.example");
        expect(hostKey("https://jenkins.example:8443")).toBe("jenkins.example:8443");
    });

    test("survives a value that is not a URL", () => {
        expect(hostKey("jenkins.example/job/x")).toBe("jenkins.example");
    });
});

test("tokenPageUrl points at /me/security/, which needs no username", () => {
    expect(tokenPageUrl("https://jenkins.example")).toBe("https://jenkins.example/me/security/");
    expect(tokenPageUrl("https://jenkins.example/some/prefix")).toBe("https://jenkins.example/me/security/");
});

test("the setup message names the one command that fixes it", () => {
    const err = new JenkinsAuthMissingError("nothing anywhere");

    expect(err.message).toContain(SETUP_COMMAND);
    expect(err.message).toContain("/me/security/");
    expect(err.detail).toBe("nothing anywhere");
});

describe("one object, not a key/value spread", () => {
    test("a login writes exactly one secret holding url, user and token together", async () => {
        await saveAuth(AUTH);

        expect(store.writes).toBe(1);
        expect(SafeJSON.parse(store.vault as string)).toEqual({
            version: 1,
            defaultHost: "jenkins.example",
            hosts: { "jenkins.example": AUTH },
        });
    });

    test("a second host joins the same object and becomes the default", async () => {
        await saveAuth(AUTH);
        await saveAuth(OTHER);

        const vault = await loadVault();

        expect(Object.keys(vault?.hosts ?? {})).toEqual(["jenkins.example", "other.example"]);
        expect(vault?.defaultHost).toBe("other.example");
        expect(store.writes).toBe(2);
    });

    test("the stored URL comes back with the credentials, so nothing needs JENKINS_URL", async () => {
        await saveAuth(AUTH);

        await env.testing.withOverrides(NOTHING_SET, async () => {
            expect(await resolveAuth()).toEqual({ ...AUTH, source: "store" });
        });
    });
});

describe("resolveAuth", () => {
    test("a complete environment wins over the store", async () => {
        await saveAuth(AUTH);

        await env.testing.withOverrides(
            { JENKINS_URL: AUTH.url, JENKINS_USER: "from-env", JENKINS_TOKEN: "env-token" },
            async () => {
                const resolved = await resolveAuth();

                expect(resolved.source).toBe("env");
                expect(resolved.user).toBe("from-env");
            }
        );
    });

    test("JENKINS_URL alone selects that host from the store", async () => {
        await saveAuth(AUTH);
        await saveAuth(OTHER);

        await env.testing.withOverrides({ ...NOTHING_SET, JENKINS_URL: AUTH.url }, async () => {
            expect((await resolveAuth()).user).toBe(AUTH.user);
        });
    });

    test("a URL alone is config, not a half-set credential", async () => {
        await env.testing.withOverrides({ ...NOTHING_SET, JENKINS_URL: AUTH.url }, async () => {
            const err = await resolveAuth().catch((e: unknown) => e);

            expect(err).toBeInstanceOf(JenkinsAuthMissingError);
            expect((err as InstanceType<typeof JenkinsAuthMissingError>).detail).toContain(
                "no JENKINS_USER or JENKINS_TOKEN"
            );
        });
    });

    test("a half-set secret is called out by name", async () => {
        await env.testing.withOverrides(
            { ...NOTHING_SET, JENKINS_URL: AUTH.url, JENKINS_USER: "someone" },
            async () => {
                const err = await resolveAuth().catch((e: unknown) => e);

                expect(err).toBeInstanceOf(JenkinsAuthMissingError);
                const detail = (err as InstanceType<typeof JenkinsAuthMissingError>).detail;

                expect(detail).toContain("JENKINS_TOKEN not set");
                expect(detail).not.toContain("JENKINS_USER not set");
            }
        );
    });

    test("naming an unstored host is an error that lists what IS stored, not a silent swap", async () => {
        await saveAuth(AUTH);

        await env.testing.withOverrides({ ...NOTHING_SET, JENKINS_URL: "https://nope.example" }, async () => {
            const err = await resolveAuth().catch((e: unknown) => e);

            expect(err).toBeInstanceOf(JenkinsAuthMissingError);
            const detail = (err as InstanceType<typeof JenkinsAuthMissingError>).detail;

            expect(detail).toContain("no login saved for nope.example");
            expect(detail).toContain("jenkins.example");
        });
    });

    test("says so when no master key rung can open the vault", async () => {
        store.available = false;

        await env.testing.withOverrides(NOTHING_SET, async () => {
            const err = await resolveAuth().catch((e: unknown) => e);

            expect(err).toBeInstanceOf(JenkinsAuthMissingError);
            expect((err as InstanceType<typeof JenkinsAuthMissingError>).detail).toContain("no master key rung");
        });
    });
});

describe("forgetAuth", () => {
    test("forgetting the only host clears the whole object", async () => {
        await saveAuth(AUTH);

        expect(await forgetAuth()).toBe("jenkins.example");
        expect(store.vault).toBeNull();
        expect(await readStoredAuth()).toBeNull();
    });

    test("forgetting one host keeps the other and picks a surviving default", async () => {
        await saveAuth(AUTH);
        await saveAuth(OTHER);

        expect(await forgetAuth(OTHER.url)).toBe("other.example");

        const vault = await loadVault();

        expect(Object.keys(vault?.hosts ?? {})).toEqual(["jenkins.example"]);
        expect(vault?.defaultHost).toBe("jenkins.example");
    });

    test("forgetting a host that was never stored reports nothing removed", async () => {
        await saveAuth(AUTH);

        expect(await forgetAuth("https://nope.example")).toBeNull();
        expect(await readStoredAuth(AUTH.url)).toEqual(AUTH);
    });
});

describe("a damaged object reads as absent, never as half-valid", () => {
    test("truncated JSON", async () => {
        store.vault = '{"version":1,"hosts":{"jenkins.example":{"url":"https://jenkins.example"';

        expect(await loadVault()).toBeNull();
        expect(await readStoredAuth()).toBeNull();
    });

    test("an entry missing its token is dropped", async () => {
        store.vault = SafeJSON.stringify({
            version: 1,
            defaultHost: "jenkins.example",
            hosts: { "jenkins.example": { url: AUTH.url, user: AUTH.user } },
        });

        expect(await loadVault()).toBeNull();
    });

    test("a defaultHost pointing at nothing falls back to a host that exists", async () => {
        store.vault = SafeJSON.stringify({
            version: 1,
            defaultHost: "gone.example",
            hosts: { "jenkins.example": AUTH },
        });

        expect((await loadVault())?.defaultHost).toBe("jenkins.example");
        expect(await readStoredAuth()).toEqual(AUTH);
    });

    test("nothing is stored when the vault cannot be opened", async () => {
        store.available = false;

        expect(await saveAuth(AUTH)).toBe(false);
        expect(await readStoredAuth()).toBeNull();
    });
});
