import { describe, expect, test } from "bun:test";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";

// The public 502s on mac.example.com came from a break-before-make preview
// restart: the old Vite preview was closed, then the new one was built and
// bound, and every request in between hit a dead upstream. These tests pin the
// proxy half of the fix — the upstream port is read per request, so a
// make-before-break swap is invisible to clients — plus the negative control
// proving a genuinely dead upstream still 502s (without it, "no 502 seen" would
// pass for a proxy that can no longer produce one).

function startUpstream(body: string) {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(body),
    });
}

function boundPort(server: { port?: number }): number {
    if (server.port === undefined) {
        throw new Error("Bun.serve did not report a bound port");
    }

    return server.port;
}

function freePort(): number {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = boundPort(probe);
    probe.stop(true);

    return port;
}

describe("front proxy upstream swap (make-before-break)", () => {
    test("swapping the upstream under load never returns 502", async () => {
        const upstreamA = startUpstream("A");
        let currentPort = boundPort(upstreamA);

        const proxy = startFrontProxy({
            publicPort: 0,
            internalPort: () => currentPort,
            hostname: "127.0.0.1",
        });

        const statuses: number[] = [];
        const bodies = new Set<string>();
        let running = true;

        const load = (async () => {
            while (running) {
                const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
                statuses.push(res.status);
                bodies.add(await res.text());
                await Bun.sleep(5);
            }
        })();

        try {
            await Bun.sleep(60);

            // Make before break: the replacement is listening and proven before
            // the old one is closed, and only then does the proxy follow it.
            const upstreamB = startUpstream("B");
            currentPort = boundPort(upstreamB);
            upstreamA.stop(true);

            await Bun.sleep(120);
            running = false;
            await load;

            expect(statuses.length).toBeGreaterThan(5);
            expect(statuses.filter((s) => s === 502)).toEqual([]);
            expect(bodies).toEqual(new Set(["A", "B"]));

            upstreamB.stop(true);
        } finally {
            running = false;
            proxy.stop(true);
        }
    });

    test("a dead upstream still 502s with a classified reason (negative control)", async () => {
        const proxy = startFrontProxy({
            publicPort: 0,
            internalPort: freePort(),
            hostname: "127.0.0.1",
        });

        try {
            const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
            expect(res.status).toBe(502);
            expect(await res.text()).toBe("Bad Gateway: upstream unavailable (upstream-refused)");
        } finally {
            proxy.stop(true);
        }
    }, 20_000);
});
