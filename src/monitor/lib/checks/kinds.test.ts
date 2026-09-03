import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { checkCommand } from "./command";
import { checkJson, getPath, renderValue } from "./json";
import { checkTcp, parseHostPort } from "./tcp";
import { daysUntil, judgeCertificate } from "./tls";

const base = { config: {}, timeoutMs: 2_000 };

describe("parseHostPort", () => {
    test("host:port, URL, bracketed IPv6 and a default port", () => {
        expect(parseHostPort("db.local:5432")).toEqual({ host: "db.local", port: 5432 });
        expect(parseHostPort("https://example.com:8443/path")).toEqual({ host: "example.com", port: 8443 });
        expect(parseHostPort("[::1]:22")).toEqual({ host: "::1", port: 22 });
        expect(parseHostPort("example.com", 443)).toEqual({ host: "example.com", port: 443 });
    });

    test("rejects a missing or silly port", () => {
        expect(() => parseHostPort("example.com")).toThrow(/port/);
        expect(() => parseHostPort("example.com:70000")).toThrow(/port/);
    });
});

describe("checkTcp", () => {
    let listener: TCPSocketListener;

    beforeAll(() => {
        listener = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: {
                data() {},
                open(socket) {
                    socket.end();
                },
            },
        });
    });

    afterAll(() => {
        listener.stop(true);
    });

    test("an open port is up with a latency", async () => {
        const result = await checkTcp({ ...base, target: `127.0.0.1:${listener.port}` });

        expect(result.status).toBe("up");
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test("a closed port is down", async () => {
        const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const port = closed.port;
        closed.stop(true);
        const result = await checkTcp({ ...base, target: `127.0.0.1:${port}` });

        expect(result.status).toBe("down");
        expect(result.detail).toContain(`127.0.0.1:${port}`);
    });

    test("a bad target is unknown, not a crash", async () => {
        expect((await checkTcp({ ...base, target: "nowhere" })).status).toBe("unknown");
    });
});

describe("checkJson", () => {
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req) {
                const url = new URL(req.url);

                if (url.pathname === "/text") {
                    return new Response("not json", { status: 200 });
                }

                return Response.json({ status: { indicator: "none" }, items: [{ id: 7 }], ok: true });
            },
        });
    });

    afterAll(() => {
        server.stop(true);
    });

    const url = (path = "/") => `http://127.0.0.1:${server.port}${path}`;

    test("getPath reads dots and brackets", () => {
        const doc = { a: { b: [{ c: 1 }] } };

        expect(getPath(doc, "a.b[0].c")).toBe(1);
        expect(getPath(doc, "a.b.0.c")).toBe(1);
        expect(getPath(doc, "a.x")).toBeUndefined();
        expect(getPath(doc, "")).toBe(doc);
        expect(renderValue(true)).toBe("true");
    });

    test("path present and equal to expect is up", async () => {
        const result = await checkJson({
            ...base,
            target: url(),
            config: { jsonPath: "status.indicator", expect: "none" },
        });

        expect(result.status).toBe("up");
        expect(result.detail).toContain("status.indicator = none");
    });

    test("a different value or a missing path is down", async () => {
        expect(
            (await checkJson({ ...base, target: url(), config: { jsonPath: "status.indicator", expect: "major" } }))
                .status
        ).toBe("down");
        expect((await checkJson({ ...base, target: url(), config: { jsonPath: "nope.deeper" } })).status).toBe("down");
    });

    test("array index and booleans render as text", async () => {
        const result = await checkJson({ ...base, target: url(), config: { jsonPath: "items[0].id", expect: "7" } });

        expect(result.status).toBe("up");
        expect((await checkJson({ ...base, target: url(), config: { jsonPath: "ok", expect: "true" } })).status).toBe(
            "up"
        );
    });

    test("a non-JSON body is down", async () => {
        expect((await checkJson({ ...base, target: url("/text") })).detail).toContain("not JSON");
    });
});

describe("checkCommand", () => {
    test("exit 0 is up and carries the last output line", async () => {
        const result = await checkCommand({ ...base, target: "echo first; echo all good" });

        expect(result.status).toBe("up");
        expect(result.detail).toContain("all good");
    });

    test("a non-zero exit is down with the code", async () => {
        const result = await checkCommand({ ...base, target: "echo boom >&2; exit 3" });

        expect(result.status).toBe("down");
        expect(result.detail).toContain("exit 3");
        expect(result.detail).toContain("boom");
    });

    test("a hung command is killed at the timeout", async () => {
        const result = await checkCommand({ ...base, timeoutMs: 300, target: "sleep 5" });

        expect(result.status).toBe("down");
        expect(result.detail).toContain("killed");
    });
});

describe("tls judgement", () => {
    const now = Date.parse("2026-09-03T12:00:00Z");

    test("daysUntil floors whole days", () => {
        expect(daysUntil(new Date("2026-09-13T11:00:00Z"), now)).toBe(9);
        expect(daysUntil(new Date("2026-09-01T00:00:00Z"), now)).toBe(-3);
    });

    test("thresholds: expired is down, inside warn window is degraded, else up", () => {
        expect(judgeCertificate(-1, {}).status).toBe("down");
        expect(judgeCertificate(5, {}).status).toBe("degraded");
        expect(judgeCertificate(60, {}).status).toBe("up");
        expect(judgeCertificate(5, { minDays: 7 }).status).toBe("down");
        expect(judgeCertificate(20, { warnDays: 30 }).status).toBe("degraded");
    });
});
