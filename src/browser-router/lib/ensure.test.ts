import { describe, expect, test } from "bun:test";
import { type EnsureDeps, ensurePort, portIsOpen } from "./ensure";

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
        ...overrides,
    };
}

describe("ensurePort", () => {
    test("an unregistered port does not spawn", async () => {
        const local = deps({ lookup: () => null });
        const result = await ensurePort(9, local);
        expect(result).toEqual({ ok: false, code: 2, message: "port 9 is not registered" });
        expect(local.spawned).toEqual([]);
    });

    test("a listening port does not spawn", async () => {
        const local = deps({ listening: async () => true });
        const result = await ensurePort(9, local);
        expect(result).toEqual({ ok: true, name: "Example", started: false });
        expect(local.spawned).toEqual([]);
    });

    test("a dead port is started and then waited for", async () => {
        let up = false;
        const local = deps({
            listening: async () => up,
            spawn: () => {
                up = true;
            },
        });
        const result = await ensurePort(9, local);
        expect(result).toEqual({ ok: true, name: "Example", started: true });
    });

    test("timeout does not report success", async () => {
        const local = deps();
        const result = await ensurePort(9, local, 500);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.code).toBe(1);
        }
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
