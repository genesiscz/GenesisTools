import { afterEach, describe, expect, it } from "bun:test";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { findFreePort } from "@app/utils/net/free-port";
import { BoardsHttpError, boardsFetch, resetBoardsBaseUrl } from "./http";

afterEach(() => {
    env.testing.unset("BOARDS_BASE_URL");
    resetBoardsBaseUrl();
});

describe("boardsFetch", () => {
    it("parses a happy JSON response", async () => {
        const port = await findFreePort();
        const server = Bun.serve({
            port,
            fetch: () => Response.json({ ok: true }),
        });
        try {
            env.testing.set("BOARDS_BASE_URL", `http://127.0.0.1:${port}`);
            const res = await boardsFetch<{ ok: boolean }>("/anything");
            expect(res.ok).toBe(true);
        } finally {
            server.stop();
        }
    });

    it("throws BoardsHttpError with the status on a non-2xx response", async () => {
        const port = await findFreePort();
        const server = Bun.serve({
            port,
            fetch: () => new Response(SafeJSON.stringify({ error: "nope" }), { status: 404 }),
        });
        try {
            env.testing.set("BOARDS_BASE_URL", `http://127.0.0.1:${port}`);
            const err = await boardsFetch("/missing").catch((e: unknown) => e);
            expect(err).toBeInstanceOf(BoardsHttpError);
            expect((err as BoardsHttpError).status).toBe(404);
        } finally {
            server.stop();
        }
    });

    it("throws an actionable message when the server is unreachable", async () => {
        const port = await findFreePort();
        env.testing.set("BOARDS_BASE_URL", `http://127.0.0.1:${port}`);
        await expect(boardsFetch("/anything")).rejects.toThrow(/dev-dashboard unreachable/);
    });
});
