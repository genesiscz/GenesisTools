import { describe, expect, spyOn, test } from "bun:test";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { DETACHED_ENV, takeDetachedMarker } from "@genesiscz/utils/cli/detached";
import { type EnsureDeps, ensurePort, parsePort, portIsOpen } from "./ensure";

function deps(overrides: Partial<EnsureDeps> = {}): EnsureDeps & { spawned: string[]; clock: { t: number } } {
    const clock = { t: 0 };
    const spawned: string[] = [];
    return {
        clock,
        spawned,
        lookup: () => ({ name: "Example", launch: "tools example" }),
        listening: async () => false,
        spawn: (launch) => {
            spawned.push(launch);
        },
        sleep: async () => {
            clock.t += 200;
        },
        now: () => clock.t,
        logPath: () => "/tmp/example-day.log",
        ...overrides,
    };
}

/** A start where none may happen fails the test loudly instead of being counted afterwards. */
function spawnMustNotRun(launch: string): void {
    throw new Error(`spawned ${launch}`);
}

describe("ensurePort", () => {
    test("an unregistered port does not spawn", async () => {
        const result = await ensurePort(9, deps({ lookup: () => null, spawn: spawnMustNotRun }));
        expect(result).toEqual({ ok: false, code: 2, message: "port 9 is not registered" });
    });

    test("a listening port does not spawn", async () => {
        const result = await ensurePort(9, deps({ listening: async () => true, spawn: spawnMustNotRun }));
        expect(result).toEqual({ ok: true, name: "Example", started: false });
    });

    test("a registered entry without a launch command does not spawn", async () => {
        const result = await ensurePort(
            9,
            deps({ lookup: () => ({ name: "Example", launch: null }), spawn: spawnMustNotRun })
        );
        expect(result).toEqual({ ok: false, code: 2, message: "Example has no launch command" });
    });

    test("a dead port is started once and then waited for", async () => {
        let up = false;
        const spawned: string[] = [];
        const local = deps({
            listening: async () => up,
            spawn: (launch) => {
                spawned.push(launch);
                up = true;
            },
        });
        const result = await ensurePort(9, local);
        expect(result).toEqual({ ok: true, name: "Example", started: true });
        expect(spawned).toEqual(["tools example"]);
    });

    test("a timeout is exit 1, names the log, and never reports success", async () => {
        const local = deps();
        const result = await ensurePort(9, local, 500);
        expect(result).toEqual({
            ok: false,
            code: 1,
            message: "Example did not listen on 9 within 500ms. Log: /tmp/example-day.log",
        });
        expect(local.spawned).toEqual(["tools example"]);
    });

    test("the wait never polls faster than 100 ms", async () => {
        const waits: number[] = [];
        const local = deps();
        local.sleep = async (ms) => {
            waits.push(ms);
            local.clock.t += ms;
        };
        await ensurePort(9, local, 1_050);
        expect(Math.min(...waits)).toBeGreaterThanOrEqual(100);
    });
});

describe("parsePort", () => {
    test("only a whole number from 1 to 65535 is a port; anything else is refused before the lookup", () => {
        expect(parsePort("3042")).toBe(3042);
        expect(["abc", "", "0", "65536", "30.5", "-5", " 42", "1e3"].map(parsePort)).toEqual(Array(8).fill(null));
    });
});

describe("portIsOpen", () => {
    test("a server that listens only on ::1 counts as up", async () => {
        const server = listenOnIpv6Loopback();

        // A runner without IPv6 loopback cannot host this case; the IPv4 path is covered below.
        if (!server) {
            return;
        }

        try {
            expect(await portIsOpen(server.port)).toBe(true);
        } finally {
            server.stop(true);
        }
    });

    test("a port nobody listens on is down", async () => {
        const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const port = probe.port;
        probe.stop(true);

        expect(await portIsOpen(port)).toBe(false);
    });
});

function listenOnIpv6Loopback() {
    try {
        return Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    } catch (error) {
        expect(error).toBeDefined();
        return null;
    }
}

describe("detached start", () => {
    test("spawnToolDetached marks the child so the tools wrapper skips its orphan watchdog", () => {
        let env: Record<string, string | undefined> = {};
        const spawn = spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options: { env: typeof env }) => {
            env = options.env;
            return { pid: 4242, unref: () => undefined };
        }) as unknown as typeof Bun.spawn);

        try {
            expect(spawnToolDetached(["example", "serve"])).toBe(4242);
        } finally {
            spawn.mockRestore();
        }

        expect(env[DETACHED_ENV]).toBe("1");
        // The wrapper reads the marker once and removes it, so the tool's own `tools` calls keep the watchdog.
        expect(takeDetachedMarker(env)).toBe(true);
        expect(env[DETACHED_ENV]).toBeUndefined();
        expect(takeDetachedMarker(env)).toBe(false);
        expect(takeDetachedMarker({ [DETACHED_ENV]: "0" })).toBe(false);
    });
});
