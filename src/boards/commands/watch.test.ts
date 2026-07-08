import { afterEach, describe, expect, it } from "bun:test";
import { ANNOUNCED_POLL_PACE_MS, resolveScope, runWatch } from "./watch";

describe("resolveScope", () => {
    it("slugifies the branch exactly as push writes it, so watch matches its own work", () => {
        const scope = resolveScope({ project: "p", branch: "feat/Cool-Thing" }, "/tmp");
        expect(scope).toEqual({ kind: "project", project: "p", branch: "feat-cool-thing" });
    });
});

describe("runWatch", () => {
    let server: ReturnType<typeof Bun.serve> | undefined;

    afterEach(() => {
        server?.stop(true);
        server = undefined;
    });

    it("announces open work, then exits 2 on a live-holder conflict", async () => {
        let waitCall = 0;
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);

                if (url.pathname === "/api/boards/work/wait") {
                    waitCall += 1;
                    if (waitCall === 1) {
                        return Response.json({ idle: true, listener: 1 });
                    }
                    if (waitCall === 2) {
                        return Response.json({
                            work: [{ id: 1, board: "demo", capsule: "..." }],
                            pending: 1,
                            listener: 1,
                        });
                    }
                    return Response.json(
                        {
                            error: "scope held by a live listener",
                            live: true,
                            holder: {
                                id: 9,
                                scopeKind: "board",
                                scope: "demo",
                                branch: "",
                                actor: "someone-else",
                                session: "otherhost:123",
                                createdAt: "",
                                lastSeen: "",
                            },
                        },
                        { status: 409 }
                    );
                }

                if (url.pathname === "/api/boards/work") {
                    return Response.json({
                        work: [
                            {
                                id: 1,
                                board: "demo",
                                cardId: 1,
                                intent: "fix",
                                status: "open",
                                prompt: "tighten the spacing",
                                createdAt: "2026-07-08T00:00:00.000Z",
                                updatedAt: "2026-07-08T00:00:00.000Z",
                            },
                        ],
                    });
                }

                if (url.pathname.startsWith("/api/boards/work/listeners/")) {
                    return Response.json({ reverted: [] });
                }

                return new Response("not found", { status: 404 });
            },
        });

        const lines: string[] = [];
        const exitCode = await runWatch({
            base: `http://127.0.0.1:${server.port}`,
            scope: { kind: "board", board: "demo" },
            session: "testhost:1",
            actor: "tester",
            once: false,
            takeover: false,
            print: async (line) => {
                lines.push(line);
            },
            sleep: async () => {},
        });

        expect(exitCode).toBe(2);
        expect(lines).toEqual([
            "№1 [fix] demo: tighten the spacing",
            "⚠ boards scope held by live listener otherhost:123",
        ]);
    });

    it("paces re-polls while work stays open, instead of busy-spinning /work/wait", async () => {
        // /work/wait returns immediately (no blocking) whenever the scope already has open
        // work — so a continuous loop MUST pace itself between "announced" iterations, or it
        // hammers the server in a zero-delay spin for as long as the annotation stays open.
        let waitCall = 0;
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);

                if (url.pathname === "/api/boards/work/wait") {
                    waitCall += 1;
                    if (waitCall <= 2) {
                        return Response.json({ work: [{ id: 1, board: "demo", capsule: "..." }], pending: 1 });
                    }
                    return Response.json(
                        {
                            error: "scope held by a live listener",
                            live: true,
                            holder: {
                                id: 1,
                                scopeKind: "board",
                                scope: "demo",
                                branch: "",
                                actor: "x",
                                session: "otherhost:1",
                                createdAt: "",
                                lastSeen: "",
                            },
                        },
                        { status: 409 }
                    );
                }

                if (url.pathname === "/api/boards/work") {
                    return Response.json({
                        work: [
                            {
                                id: 1,
                                board: "demo",
                                cardId: 1,
                                intent: "fix",
                                status: "open",
                                prompt: "tighten the spacing",
                                createdAt: "2026-07-08T00:00:00.000Z",
                                updatedAt: "2026-07-08T00:00:00.000Z",
                            },
                        ],
                    });
                }

                return new Response("not found", { status: 404 });
            },
        });

        const sleeps: number[] = [];
        const lines: string[] = [];
        const exitCode = await runWatch({
            base: `http://127.0.0.1:${server.port}`,
            scope: { kind: "board", board: "demo" },
            session: "testhost:1",
            actor: "tester",
            once: false,
            takeover: false,
            print: async (line) => {
                lines.push(line);
            },
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });

        expect(exitCode).toBe(2);
        // Call 1 announces the new item and paces; call 2 sees the same item (unchanged, 0
        // new lines) and still paces; call 3 conflicts and returns without sleeping.
        expect(sleeps).toEqual([ANNOUNCED_POLL_PACE_MS, ANNOUNCED_POLL_PACE_MS]);
        expect(lines).toEqual([
            "№1 [fix] demo: tighten the spacing",
            "⚠ boards scope held by live listener otherhost:1",
        ]);
    });

    it("--once exits 3 on an idle wait, printing nothing", async () => {
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/api/boards/work/wait") {
                    return Response.json({ idle: true });
                }
                return new Response("not found", { status: 404 });
            },
        });

        const lines: string[] = [];
        const exitCode = await runWatch({
            base: `http://127.0.0.1:${server.port}`,
            scope: { kind: "all" },
            session: "testhost:1",
            actor: "tester",
            once: true,
            takeover: false,
            print: async (line) => {
                lines.push(line);
            },
        });

        expect(exitCode).toBe(3);
        expect(lines).toEqual([]);
    });

    it("--once is lease-free: the wait URL carries no session or actor", async () => {
        let waitSearch = "";
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/api/boards/work/wait") {
                    waitSearch = url.search;
                    return Response.json({ idle: true });
                }
                return new Response("not found", { status: 404 });
            },
        });

        const exitCode = await runWatch({
            base: `http://127.0.0.1:${server.port}`,
            scope: { kind: "all" },
            session: "testhost:1",
            actor: "tester",
            once: true,
            takeover: false,
            print: async () => {},
        });

        expect(exitCode).toBe(3);
        expect(waitSearch).not.toContain("session=");
        expect(waitSearch).not.toContain("actor=");
    });

    it("--once exits 0 and prints announcements when work is open", async () => {
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/api/boards/work/wait") {
                    return Response.json({ work: [{ id: 5, board: "demo", capsule: "..." }], pending: 1 });
                }
                if (url.pathname === "/api/boards/work") {
                    return Response.json({
                        work: [
                            {
                                id: 5,
                                board: "demo",
                                cardId: 2,
                                intent: "redesign",
                                status: "open",
                                prompt: "make it pop",
                                createdAt: "2026-07-08T00:00:00.000Z",
                                updatedAt: "2026-07-08T00:00:00.000Z",
                            },
                        ],
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });

        const lines: string[] = [];
        const exitCode = await runWatch({
            base: `http://127.0.0.1:${server.port}`,
            scope: { kind: "project", project: "demo", branch: "main" },
            session: "testhost:1",
            actor: "tester",
            once: true,
            takeover: false,
            print: async (line) => {
                lines.push(line);
            },
        });

        expect(exitCode).toBe(0);
        expect(lines).toEqual(["№5 [redesign] demo: make it pop"]);
    });

    it("--once exits 3 (not a distinct error code) when the server is unreachable", async () => {
        const exitCode = await runWatch({
            base: "http://127.0.0.1:1", // nothing listens on port 1
            scope: { kind: "all" },
            session: "testhost:1",
            actor: "tester",
            once: true,
            takeover: false,
            print: async () => {},
        });

        expect(exitCode).toBe(3); // two-outcome probe contract: transport failure reads as "no work"
    });
});
